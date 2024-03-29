/* Imports. */
import constants from "app/constants";
import { SearchEngine, SearchResult, SearchResults } from "../types.js";
import { Request, Response, Router } from "express";

import * as smart from "engines/smart";
import * as youtube from "engines/youtube";
import * as spotify from "engines/spotify";

import { identifyId } from "app/utils";

export const blankResult: SearchResult = {
    artist: "",
    duration: 0,
    icon: "",
    title: "",
    url: "",
    id: ""
};
export const noResults: SearchResults = {
    top: blankResult,
    results: [blankResult]
};

/**
 * Perform a search request.
 * @param req The HTTP request.
 * @param rsp The new response.
 */
async function searchFor(req: Request, rsp: Response): Promise<void> {
    // Pull arguments.
    const query: string = req.params.query;
    const engine: SearchEngine = <SearchEngine>req.query.query || "YouTube";

    // Pull filter settings.
    const filter: string = <string>req.query.filter || "none";

    // Perform a search request.
    let result: SearchResults = noResults;
    switch (engine) {
        case "YouTube":
            result = await youtube.search(query);
            break;
        case "Spotify":
            result = await spotify.search(query, filter == "smart");
            break;
        case "SoundCloud":
            // TODO: Perform SoundCloud search.
            break;
        case "All":
            result = await smart.search(query);
            break;
    }

    // Check if the result is empty.
    if (result == noResults) {
        rsp.status(404).send(constants.NO_RESULTS());
    } else {
        rsp.status(301).send(result);
    }
}

/**
 * Fetches a track by URL.
 * @param req The HTTP request.
 * @param rsp The new response.
 */
async function fetchTrack(req: Request, rsp: Response): Promise<void> {
    // Pull arguments.
    const id: string = req.params.id;
    let engine: string = <string> req.query.query || "";

    // Check if the arguments are valid.
    if (id == null) {
        rsp.status(400).send(constants.INVALID_ARGUMENTS());
        return;
    }

    // Identify engine.
    if (engine == "") {
        engine = identifyId(id);
    }

    // Fetch the track.
    let result = null;
    switch (engine) {
    case "YouTube":
        result = await smart.fetchTrack(id, engine);
        break;
    case "Spotify":
        result = await spotify.searchIsrc(id);
        break;
    }

    if (result == null) {
        rsp.status(404).send(constants.NO_RESULTS());
    }

    // Send the result.
    rsp.status(301).send(result);
}

/**
 * Reverses a track by ID.
 * @param req The HTTP request.
 * @param rsp The new response.
 */
async function reverseTrack(req: Request, rsp: Response): Promise<void> {
    // Pull arguments.
    const id: string = req.params.id;
    let engine: string = <string> req.query.query || "";

    // Check if the arguments are valid.
    if (id == null) {
        rsp.status(400).send(constants.INVALID_ARGUMENTS());
        return;
    }

    // Identify engine.
    if (engine == "") {
        engine = identifyId(id);
    }

    // Fetch the track.
    let result = null;
    switch (engine) {
        case "Spotify":
            result = await spotify.spotifyId(id);
            break;
    }

    // Check if the result is empty.
    if (result == null) {
        rsp.status(404).send(constants.NO_RESULTS());
    } else {
        rsp.status(301).send(constants.SUCCESS({ id: result }));
    }
}

/* -------------------------------------------------- */

/* Create a router. */
const app: Router = Router();

/* Configure routes. */
app.get("/search/:query", searchFor);
app.get("/fetch/:id", fetchTrack);
app.get("/reverse/:id", reverseTrack);

/* Export the router. */
export default app;
