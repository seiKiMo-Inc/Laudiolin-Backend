// This file also serves as the primary websocket handler.
// Other functionality is split into separate files.

/* Imports. */
import constants from "app/constants";

import { logger } from "app/index";
import { onlineUsers, recentUsers } from "features/social";
import { updatePresence } from "features/discord";
import * as types from "app/types";
import * as database from "features/database";

import { WebSocket } from "ws";
import { IncomingMessage } from "http";
import { isJson } from "app/utils";
import { randomUUID } from "crypto";

import type {
    GatewayMessage, InitializeMessage, OfflineUser,
    OnlineUser, Presence, PresenceMode, SocialStatus, Track, User
} from "app/types";
import { PresenceType } from "app/types";

let hasBot: boolean = false;
const clients: { [key: string]: Client } = {};
export const users: { [key: string]: Client[] } = {};

/**
 * Handles a new websocket connection.
 * Adds listeners to events.
 * @param ws The socket connection.
 * @param incMsg The incoming message.
 */
function handleConnection(ws: WebSocket, incMsg: IncomingMessage): void {
    // Create an ID for the socket & create a client.
    ws["id"] = randomUUID().toString();
    const client = (clients[ws["id"]] = new Client(ws));

    // Add event handlers.
    ws.on("message", client.handleMessage.bind(client));
    ws.on("close", client.handleClose.bind(client));
}

/**
 * Broadcasts a message to all clients.
 * @param userId The user ID to broadcast to.
 * @param payload The payload to send.
 */
function broadcast(userId: string, payload: GatewayMessage): void {
    // Get the clients.
    const clients = users[userId];
    if (!clients) return;

    // Send the message to each client.
    for (const client of clients) {
        client.send(payload);
    }
}

/* A collection of message handlers. */
const handlers = {
    /* Gateway ping. (client) */
    latency: require("messages/latency"),
    /* Player progress. (client) */
    seek: require("messages/seek"),
    /* Update volume. (client) */
    volume: require("messages/volume"),
    /* Listen along. (client) */
    listen: require("messages/listen"),
    /* Player state. (client) */
    player: require("messages/player"),

    /* Load users. (bot) */
    "load-users": require("messages/bot/userLoad"),
    /* Update user. (bot) */
    "user-update": require("messages/bot/userState"),
};

/* Create a connection handler. */
export default function (socket: WebSocket, incMsg: IncomingMessage): void {
    // Process the connection.
    handleConnection(socket, incMsg);
}

/**
 * Tries to get a client in the gateway by the user ID.
 * @param userId The user ID to search for.
 */
export function getUserById(userId: string): Client[] | null {
    return users[userId] || null;
}

export class Client {
    private hasInitialized: boolean = false;
    private userId: string = null;
    lastPing: number = Date.now();

    /* Player information. */
    startedListening: number | null = null
    listeningTo: Track | null = null;
    paused: boolean = true;
    progress: number = 0;
    volume: number = 1.0;

    /* Social information. */
    socialStatus: SocialStatus = "Nobody";
    presenceMode: PresenceMode = "None";
    listeningAlong: { [key: string]: Client } = {};
    listeningWith: Client | null = null;
    lastUpdate: number = Date.now();

    constructor(private readonly socket: WebSocket) {
        // Send the initialize message.
        this.send(constants.GATEWAY_INIT());
        // Log a message to the console.
        logger.debug(`New client connected: ${this.getId()}`);
    }

    /*
     * Getters.
     */

    /**
     * Returns the client's login state.
     */
    isLoggedIn(): boolean {
        return this.userId != null;
    }

    /**
     * Returns the client's socket.
     */
    getHandle(): WebSocket {
        return this.socket;
    }

    /**
     * Returns the associated user.
     */
    async getUser(): Promise<types.User> {
        return await database.getUser(this.userId);
    }

    /**
     * Returns the client's ID.
     */
    getId(): string {
        return this.socket["id"];
    }

    /**
     * Returns the client's user's ID.
     */
    getUserId(): string | null {
        return this.userId;
    }

    /*
     * Social utilities.
     */

    /**
     * Listen along to another client.
     * @param client The client to listen along with.
     */
    listenAlong(client: Client): void {
        // Add this client to the target's listening along list.
        client.listeningAlong[this.getId()] = this;
        // Set this client's listening with.
        this.listeningWith = client;

        // Sync with the target.
        this.syncWith(true);
    }

    /**
     * Stops listening along with another client.
     */
    stopListeningAlong(host: boolean = false): void {
        // Check if the client is listening along.
        if (!this.listeningWith) return;

        // Remove this client from the listening along list.
        delete this.listeningWith.listeningAlong[this.getId()];
        // Remove the listening with.
        this.listeningWith = null;

        // Check if the host left.
        if (host) {
            // Send null sync message.
            this.send(<types.SyncMessage> {
                type: "sync",
                track: null,
                progress: -1,
                paused: true
            });
        }
    }

    /**
     * Syncs this client with the listening with client.
     */
    syncWith(seek: boolean = false): void {
        // Check if the client is listening with someone.
        if (!this.listeningWith) return;

        // Send a sync message.
        this.send(<types.SyncMessage> {
            type: "sync",
            track: this.listeningWith.listeningTo,
            progress: this.listeningWith.progress,
            paused: this.listeningWith.paused,
            seek
        });
    }

    /**
     * Syncs listeners with the host.
     */
    updateListeners(): void {
        const listeners = Object.values(this.listeningAlong);
        // Check if there are any listeners.
        if (listeners.length < 1) return;

        // Send a sync message to each listener.
        listeners.forEach(listener =>
            listener.syncWith(true));
    }

    /**
     * Update the online status of the client.
     */
    async updateOnlineStatus(sync?: number): Promise<void> {
        // Get the online user.
        let online = onlineUsers[this.getUserId()];
        if (!online) {
            online = onlineUsers[this.getUserId()] =
                await this.asOnlineUser();
        }

        // Validate the user.
        if (!online) return;

        // Update the online status.
        online.listeningTo = this.listeningTo;
        online.progress = sync ?? this.progress;
    }

    /**
     * Updates the client's presence.
     */
    async updatePresence(): Promise<void> {
        // Check if the client should update.
        if (Date.now() - this.lastUpdate < 4e3) return;
        // Update the last update time.
        this.lastUpdate = Date.now();

        // Fetch the user.
        const user = await this.getUser();
        // Check if the user is valid.
        if (!user) return;

        // Check if the presence mode is set to none.
        if (this.presenceMode == "None") {
            if (user.presenceToken)
                // Clear the presence.
                await updatePresence(user, null);
            return;
        }

        // Check if the presence should be cleared.
        const track = this.listeningTo;
        if (!track) {
            // Clear the presence.
            await updatePresence(user, null);
            return;
        }

        let presence: Presence = {
            platform: "desktop",
            id: "laudiolin",
            name: "Laudiolin",
            type: PresenceType.Playing,
            application_id: constants.DISCORD_CLIENT_ID,

            details: `Listening to ${track.title}`,
            state: track.artist,
            timestamps: {
                start: this.startedListening,
                end: this.startedListening + (track.duration * 1000)
            },
            assets: {
                large_image: track.icon,
                large_text: track.title,
                small_image: constants.DISCORD_ICON,
                small_text: "Laudiolin"
            },
            buttons: [
                {
                    label: "Play on Laudiolin",
                    url: `${constants.WEB_TARGET}/track/${track.id}`
                },
                {
                    label: "Listen Along",
                    url: `${constants.WEB_TARGET}/listen/${user.userId}`
                }
            ]
        };

        if (this.presenceMode == "Simple") {
            if (!constants.CUSTOM_LISTENING) {
                presence.type = PresenceType.Listening;
                presence.id = "spotify:1";
                presence.name = "Spotify";
                presence.details = track.title;
                presence.assets.large_text = "Laudiolin";
                presence.session_id = "4efa609dfa405bb70c0da334220d4a3f";
                presence.party = {
                    id: "spotify:852697865012117544"
                };
                presence.flags = 48;
            } else {
                presence.type = PresenceType.Listening;
                presence.details = track.title;
            }
        }

        // Update the presence.
        await updatePresence(user, presence);
    }

    /*
     * Websocket utilities.
     */

    /**
     * Disconnects the client.
     */
    disconnect(code?: number): void {
        this.socket.close(code);
    }

    /**
     * Sends a message to the client.
     * @param data The data to send.
     */
    send(data: any): void {
        if (!data.timestamp) data.timestamp = Date.now();

        this.socket.send(JSON.stringify(data));
    }

    /*
     * Utility checks.
     */

    /**
     * Adds the track to the recently played list.
     * @param track The track to add.
     */
    async addRecentlyPlayed(track: Track): Promise<void> {
        // Get the user from the database.
        const user = await this.getUser();

        // Pull the list of recently played tracks.
        const recentlyPlayed = user.recentlyPlayed || [];
        // Check if the track is already in the list.
        const index = recentlyPlayed.findIndex(t => t?.id == track?.id);
        if (index != -1)
            // Remove the track from the list.
            recentlyPlayed.splice(index, 1);
        // Add the track to the start of the list.
        recentlyPlayed.unshift(track);

        // Update the user's recently played tracks.
        user.recentlyPlayed = recentlyPlayed.slice(0, 9);

        // Save the user.
        await database.updateUser(user);
        // Send the recently played list.
        broadcast(this.userId, <types.RecentsMessage> {
            type: "recents",
            recents: user.recentlyPlayed
        });
    }

    /**
     * Converts this user into an online user.
     */
    async asOnlineUser(user?: User): Promise<OnlineUser|null> {
        user = user ?? await this.getUser();
        return user ? {
            socialStatus: this.socialStatus,
            username: user.username,
            discriminator: user.discriminator,
            userId: user.userId,
            avatar: user.avatar,
            progress: this.progress,
            listeningTo: this.listeningTo
        } : null;
    }

    /**
     * Converts this user into an offline user.
     */
    async asOfflineUser(user?: User): Promise<OfflineUser|null> {
        user = user ?? await this.getUser();
        return user ? {
            socialStatus: this.socialStatus,
            username: user.username,
            discriminator: user.discriminator,
            userId: user.userId,
            avatar: user.avatar,
            lastSeen: Date.now(),
            lastListeningTo: this.listeningTo
        } : null;
    }

    /**
     * Pings the client.
     */
    ping(): void {
        // Calculate the latency.
        const latency: number = Date.now() - this.lastPing;
        // Send a ping message.
        this.send(constants.GATEWAY_PING(latency));
    }

    /**
     * Checks if this client has initialized.
     * @param data The data received.
     * @private
     */
    private initialized(data: GatewayMessage): boolean {
        if (this.hasInitialized) return true;

        // Check if the client has initialized.
        if (!this.hasInitialized && data.type != "initialize") return false;

        // Set the initialized flag.
        this.hasInitialized = true;
        // Ping the client.
        this.ping();

        // Check if the message is from a bot.
        const { token, broadcast, presence } = data as InitializeMessage;
        if (!hasBot && token == constants.DISCORD_TOKEN) {
            setTimeout(async () => {
                // Set the user as the bot.
                this.userId = "bot"; hasBot = true;
                // Log a message to the console.
                logger.debug(`Client ${this.getId()} initialized as bot.`);

                // Fetch for online members.
                this.send(constants.SUCCESS({ type: "fetch" }));
            }, 1000);
        } else {
            setTimeout(async () => {
                // Attempt to find the user.
                const user = await database.getUserByToken(token);

                // Check if the user was found.
                if (user) {
                    // Set the user.
                    this.userId = user.userId;
                    // Log a message to the console.
                    logger.debug(`Client ${this.getId()} initialized as ${user.userId}.`);

                    // Update the users list.
                    if (!users[user.userId])
                        users[user.userId] = [];
                    users[user.userId].push(this);

                    // Set the user's social status.
                    this.socialStatus = broadcast ?? "Everyone";
                    // Set the user's presence type.
                    this.presenceMode = presence ?? "None";

                    // Remove the user from the list of recent users.
                    recentUsers[user.userId] && (delete recentUsers[user.userId]);
                    // Add the user to the collection of online users.
                    const online = await this.asOnlineUser(user);
                    online && (onlineUsers[user.userId] = online);

                    // Check if the user has a presence token.
                    if (user.presenceToken) {
                        // Clear the existing presence.
                        await this.updatePresence();
                    }
                } else {
                    // Send an error message.
                    this.send(constants.GATEWAY_INVALID_TOKEN());
                    // Log a message to the console.
                    logger.debug(`Client ${this.getId()} has provided an invalid token.`);
                    // Disconnect the client.
                    this.disconnect();
                }
            }, 1000);
        }

        return true;
    }

    /*
     * Event handlers.
     */

    /**
     * Handles a received message.
     * @param data The data received.
     */
    handleMessage(data: string): void {
        // Check if the data is JSON.
        if (!isJson(data)) {
            // Send an error message.
            this.send(constants.INVALID_JSON());
            // Log a message to the console.
            logger.debug(`Invalid JSON received from ${this.getId()}.`);
            // Disconnect the client.
            this.disconnect();
            return;
        }

        // Parse the JSON.
        const json: GatewayMessage = JSON.parse(data);
        // Do initialization check.
        if (!this.initialized(json)) {
            // Send an error message.
            this.send(constants.GATEWAY_NOT_INITIALIZED());
            // Log a message to the console.
            logger.debug(`Client ${this.getId()} has not initialized.`);
            // Disconnect the client.
            this.disconnect();
            return;
        }
        if (json.type == "initialize") return;

        // Handle the message.
        const handler = handlers[json.type];
        if (handler) {
            // noinspection TypeScriptValidateJSTypes
            handler.default(this, json);
        } else {
            // Send an error message.
            this.send(constants.GATEWAY_UNKNOWN_MESSAGE());
            // Log a message to the console.
            logger.debug(`Unknown message received from ${this.getId()}.`, json);
            // Disconnect the client.
            this.disconnect();
            return;
        }
    }

    /**
     * Handles the client disconnecting.
     */
    async handleClose(): Promise<void> {
        // Log a message to the console.
        logger.debug("Client disconnected.");

        // Remove the client from listening along states.
        if (this.listeningWith) this.stopListeningAlong();
        // Check if the client has listeners.
        if (Object.keys(this.listeningAlong).length > 0) {
            // Stop listening along with the client.
            Object.values(this.listeningAlong).forEach(
                client => client.stopListeningAlong(true));
        }

        // Clear the client's rich presence.
        await updatePresence(this.userId, null);

        // Remove the client from the 'clients' collection.
        delete clients[this.getId()];
        if (this.userId && users[this.userId]) {
            // Add the user to a list of recent users.
            if (!recentUsers[this.userId] && this.listeningTo) {
                const offlineUser = await this.asOfflineUser();
                offlineUser && (recentUsers[this.userId] = {
                    ...offlineUser,
                    lastSeen: Date.now(),
                    lastListeningTo: this.listeningTo
                });
            }

            // Remove the user from online users.
            onlineUsers[this.userId] && delete onlineUsers[this.userId];

            // Remove the user from the 'users' collection.
            if (users[this.userId].length < 2)
                delete users[this.userId];
            else
                users[this.userId]
                    .splice(users[this.userId]
                        .indexOf(this), 1);
        }
    }
}
