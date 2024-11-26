import {
  TextDocuments,
  InitializeParams,
  InitializeResult,
  CodeActionKind,
  DeclarationParams,
  Diagnostic,
  DidChangeConfigurationNotification,
  Connection,
  ReferenceParams,
} from 'vscode-languageserver'
import { createConnection, IPCMessageReader, IPCMessageWriter } from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { setLogger as setErrorLogger } from './util';
import { analyzeProgram } from './index';
import fs from 'fs';

function getConnection(): Connection {
  if (process.argv.includes('--stdio')) {
    return createConnection(process.stdin, process.stdout);
  }
  else {
    return createConnection(new IPCMessageReader(process), new IPCMessageWriter(process))
  }
}

let hasCodeActionLiteralsCapability = false
let hasConfigurationCapability = false

export function startServer(): void {
  const connection: Connection = getConnection()

  console.log = connection.console.log.bind(connection.console)
  console.error = connection.console.error.bind(connection.console)

  const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument)

  connection.onInitialize((params: InitializeParams) => {
    // connection.console.info(`Default version of Prisma 'prisma-schema-wasm':`)
    const capabilities = params.capabilities

    hasCodeActionLiteralsCapability = Boolean(capabilities?.textDocument?.codeAction?.codeActionLiteralSupport)
    hasConfigurationCapability = Boolean(capabilities?.workspace?.configuration)

    const result: InitializeResult = {
      capabilities: {
        definitionProvider: true,
        referencesProvider: true,
      },
    }

    if (hasCodeActionLiteralsCapability) {
      result.capabilities.codeActionProvider = {
        codeActionKinds: [CodeActionKind.QuickFix],
      }
    }

    return result
  })

  connection.onInitialized(() => {
    if (hasConfigurationCapability) {
      connection.client.register(DidChangeConfigurationNotification.type, undefined)
    }
  })

  connection.onDidChangeConfiguration((_change) => {
    for (let document of documents.all()) {
      validateDocument(document)
    }
  })

  documents.onDidClose((_e) => {})

  async function validateDocument(textDocument: TextDocument) {
    let diagnostics: Diagnostic[] = []
    setErrorLogger((position, message, _context) => {
      diagnostics.push({
        message,
        range: { 
          start: { line: position.line - 1, character: position.start },
          end: { line: position.line - 1, character: position.start }
        }
      });
    });

    /*
    let correctPath = '';
    for (let path of chadPaths) {
      if (textDocument.uri.endsWith(path)) {
        if (path.length > correctPath.length) correctPath = path;
      }
    }
    */

    let replaceMap: Map<string, string> = new Map();
    replaceMap.set('', textDocument.getText());
    let _program = analyzeProgram(replaceMap);

    await connection.sendDiagnostics({ uri: textDocument.uri, diagnostics })
  }

  documents.onDidChangeContent(async (change) => {
    await validateDocument(change.document)
  })

  connection.onDefinition(async (params: DeclarationParams) => {
    const doc = documents.get(params.textDocument.uri)
    return undefined;
  })

  connection.onReferences(async (params: ReferenceParams) => {
    const doc = documents.get(params.textDocument.uri)
    return undefined;
  })

  documents.listen(connection)
  connection.listen()
}
