// `npm start`: runs the app from source. VS Code's terminals set ELECTRON_RUN_AS_NODE,
// which would make Electron run as plain Node, so it's cleared first.
const { spawn } = require("child_process");
const electron = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(electron, [".", ...process.argv.slice(2)], { stdio: "inherit", env }).on("exit", (code) => process.exit(code ?? 0));
