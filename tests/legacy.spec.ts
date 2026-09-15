// Runs the shared scenarios against the frozen starter handler. The failures
// here are the defects the revised handler is expected to fix.

import { handle } from "../src/handler.legacy.js";
import { createHandlerScenarios } from "./scenarios.js";

createHandlerScenarios("legacy", handle);
