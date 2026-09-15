// Runs the same scenarios against the revised handler. All of them should pass.

import { handle } from "../src/handler.improved.js";
import { createHandlerScenarios } from "./scenarios.js";

createHandlerScenarios("improved", handle);
