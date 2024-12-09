"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode_1 = require("vscode");
const node_1 = require("vscode-languageclient/node");
let client;
function activate(context) {
    let serverOptions = {
        command: 'chad',
        args: ['lsp', 'src/basic.chad'],
        options: {
            cwd: '/home/josh/repos/chadscript/examples/test/'
        }
    };
    let clientOptions = {
        documentSelector: [{ scheme: 'file', language: 'chadscript' }],
        synchronize: {
            fileEvents: vscode_1.workspace.createFileSystemWatcher('**/.clientrc')
        }
    };
    // Create the language client and start the client.
    client = new node_1.LanguageClient('chadscript-lsp', 'ChadScript LSP', serverOptions, clientOptions);
    // Start the client. This will also launch the server
    client.start();
}
exports.activate = activate;
function deactivate() {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
exports.deactivate = deactivate;
//# sourceMappingURL=index.js.map