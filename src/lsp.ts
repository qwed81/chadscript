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
import { createConnection } from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { setLogger as setErrorLogger } from './util';
import { analyzeProgram } from './index';
import fs from 'fs';
import url from 'url';

let hasCodeActionLiteralsCapability = false
let hasConfigurationCapability = false

let cwd = process.cwd();

export function startServer(): void {
  const connection: Connection = createConnection(process.stdin, process.stdout);

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
    let filePath = decodeURIComponent(textDocument.uri.replace(/^file:\/\//, ''));
    filePath = filePath.replace(cwd, '').slice(1);

    /*
    await connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [
      { message: fileUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
      { message: textDocument.uri, range: { start: { line: 1, character: 0 }, end: { line: 0, character: 0 } } }
    ]})
    */

    let diagnosticMap: Map<string, Diagnostic[]> = new Map();
    setErrorLogger((position, message, _context) => {
      if (!diagnosticMap.has(position.document)) {
        diagnosticMap.set(position.document, []);
      }

      diagnosticMap.get(position.document)!.push({
        message,
        range: { 
          start: { line: position.line - 1, character: position.start },
          end: { line: position.line - 1, character: position.start }
        }
      });
    });

    let replaceMap: Map<string, string> = new Map();
    replaceMap.set(filePath, textDocument.getText());
    let _program = analyzeProgram(replaceMap);

    let sentToCurrent = false;
    for (let [fileName, diagnostics] of diagnosticMap.entries()) {
      if (fileName + '.chad' == filePath) {
        sentToCurrent = true;
      }

      let fileUri = url.pathToFileURL(fileName + '.chad').toString();
      await connection.sendDiagnostics({ uri: fileUri, diagnostics })
    }

    if (!sentToCurrent) {
      await connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] })
    }
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
