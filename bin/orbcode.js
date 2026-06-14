#!/usr/bin/env node
// Override Node's default process title so terminals (iTerm2 "current job name",
// VSCode terminal status, etc.) don't append " (node)" next to our own title.
process.title = "orbcode"
import "../dist/index.js"
