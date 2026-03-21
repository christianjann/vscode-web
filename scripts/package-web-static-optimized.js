#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * Packages the VS Code web OPTIMIZED build into a self-contained directory
 * that can be served by any static web server (e.g. `python3 -m http.server`).
 *
 * Prerequisites: run `npm run gulp vscode-web-min` first so that ../vscode-web/ is populated.
 *
 * Usage:
 *   node scripts/package-web-static-optimized.js [destination]
 *
 * Default destination: ../vscode-web-static-optimized (sibling of the repo root)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const OPTIMIZED_SRC = path.join(REPO_ROOT, '..', 'vscode-web');
const DEFAULT_DEST = path.join(REPO_ROOT, '..', 'vscode-web-static-optimized');
const dest = process.argv[2] || DEFAULT_DEST;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function cpSync(src, dst) {
	fs.cpSync(src, dst, { recursive: true, dereference: true });
}

/**
 * Check if an extension manifest is web-compatible.
 * Mirrors the logic in build/lib/extensions.ts isWebExtension().
 */
function isWebExtension(manifest) {
	if (manifest.browser) {
		return true;
	}
	if (manifest.main) {
		return false;
	}
	// neither browser nor main
	if (manifest.extensionKind !== undefined) {
		const kinds = Array.isArray(manifest.extensionKind) ? manifest.extensionKind : [manifest.extensionKind];
		if (kinds.indexOf('web') >= 0) {
			return true;
		}
	}
	if (manifest.contributes !== undefined) {
		for (const id of ['debuggers', 'terminal', 'typescriptServerPlugins']) {
			if (Object.prototype.hasOwnProperty.call(manifest.contributes, id)) {
				return false;
			}
		}
	}
	return true;
}

/** Scan extensions that are web-compatible, matching build/lib/extensions.ts scanBuiltinExtensions(). */
function scanExtensions(extensionsDir) {
	const result = [];
	if (!fs.existsSync(extensionsDir)) {
		return result;
	}
	for (const entry of fs.readdirSync(extensionsDir)) {
		const pkgPath = path.join(extensionsDir, entry, 'package.json');
		if (!fs.existsSync(pkgPath)) {
			continue;
		}
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
			if (!isWebExtension(pkg)) {
				continue;
			}
			const children = fs.readdirSync(path.join(extensionsDir, entry));
			const nlsFile = children.find(c => c === 'package.nls.json');
			const packageNLS = nlsFile ? JSON.parse(fs.readFileSync(path.join(extensionsDir, entry, nlsFile), 'utf8')) : undefined;
			const ext = { extensionPath: entry, packageJSON: pkg };
			if (packageNLS) {
				ext.packageNLS = packageNLS;
			}
			result.push(ext);
		} catch {
			// skip
		}
	}
	return result;
}

/**
 * Bundle the workspace-loader extension into dest/extensions/workspace-loader/.
 * This extension registers no new FS provider – it simply writes ZIP contents
 * into the built-in `tmp://` InMemoryFileSystemProvider that VS Code web already
 * registers under the `tmp` scheme (web.main.ts).
 *
 * Usage: navigate to http://localhost:PORT/?zip=<url-to-zip>
 * The index.html startup script detects the missing `folder` param and redirects
 * to ?zip=<url>&folder=tmp%3A%2F%2F%2Fworkspace so VS Code opens that folder on
 * the second load.  The extension then populates it from the ZIP.
 */
function bundleWorkspaceLoaderExtension(destDir) {
	const extDir = path.join(destDir, 'extensions', 'local.workspace-loader');
	fs.mkdirSync(extDir, { recursive: true });

	// Load JSZip minified source (will be inlined into extension.js)
	const jszipSrc = path.join(REPO_ROOT, 'node_modules', 'jszip', 'dist', 'jszip.min.js');

	// --- package.json ---
	const manifest = {
		name: 'workspace-loader',
		displayName: 'Workspace Loader (ZIP)',
		description: 'Loads a ZIP file from ?zip=<url> into the in-memory workspace.',
		version: '0.0.1',
		publisher: 'local',
		engines: { vscode: '*' },
		browser: './extension.js',
		activationEvents: ['*'],
		contributes: {
			configuration: {
				properties: {
					'workspaceLoader.zipUrl': {
						type: 'string',
						default: '',
						description: 'ZIP URL to populate the tmp:///workspace folder (set by index.html startup script from ?zip= URL param)',
					},
				},
			},
		},
	};
	fs.writeFileSync(path.join(extDir, 'package.json'), JSON.stringify(manifest, null, '\t'));

	// --- extension.js  (CommonJS module – required by the VS Code web extension host) ---
	// JSZip ships as UMD.  We inline it and force the CommonJS branch by wrapping
	// in an IIFE that shadows `define` so the UMD preamble can't see AMD.
	const jszipSource = fs.readFileSync(jszipSrc, 'utf8');

	const extensionJs = `// Generated by package-web-static-optimized.js – DO NOT EDIT
// CommonJS module loaded by the VS Code web extension host.
'use strict';
Object.defineProperty(exports, '__esModule', { value: true });

// ---------------------------------------------------------------------------
// Inline JSZip – shadow 'define' so UMD falls through to the CommonJS branch.
// ---------------------------------------------------------------------------
const JSZip = (function() {
	const _module = { exports: {} };
	(function(module, exports) {
		var define = undefined; // prevent UMD from calling define()
		${jszipSource}
	})(_module, _module.exports);
	return _module.exports;
})();

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
exports.activate = async function activate(context) {
	const vscode = require('vscode');
	console.error('[workspace-loader] activate() called');

	// The zip URL is injected into configurationDefaults by the index.html
	// startup script (which runs in the main window and has access to location).
	// Extensions run in a Web Worker where 'window' is not available.
	const zipUrl = vscode.workspace.getConfiguration('workspaceLoader').get('zipUrl');
	console.error('[workspace-loader] zipUrl =', zipUrl);
	if (!zipUrl) {
		console.error('[workspace-loader] no zipUrl, returning');
		return; // not a ZIP-load session
	}

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
	context.subscriptions.push(status);
	status.text = '$(sync~spin) Fetching ZIP\u2026';
	status.show();

	try {
		const resp = await fetch(zipUrl);
		if (!resp.ok) {
			throw new Error('HTTP ' + resp.status + ' for ' + zipUrl);
		}
		const zip = await JSZip.loadAsync(await resp.arrayBuffer());

		const entries = Object.entries(zip.files).filter(function(kv) { return !kv[1].dir; });

		// Detect and strip a common top-level directory (e.g. project-main/ from GitHub ZIPs)
		let stripPrefix = '';
		const names = entries.map(function(kv) { return kv[0]; });
		if (names.length > 0) {
			const firstSlash = names[0].indexOf('/');
			if (firstSlash > 0) {
				const candidate = names[0].slice(0, firstSlash + 1);
				if (names.every(function(n) { return n.startsWith(candidate); })) {
					stripPrefix = candidate;
				}
			}
		}

		status.text = '$(sync~spin) Writing ' + entries.length + ' files\u2026';

		const base = vscode.Uri.parse('tmp:/workspace');

		// Collect unique parent directories and sort so parents come before children
		const dirs = new Set();
		for (const kv of entries) {
			const rel = kv[0].slice(stripPrefix.length);
			const parts = rel.split('/');
			for (let i = 1; i < parts.length; i++) {
				dirs.add(parts.slice(0, i).join('/'));
			}
		}

		// Ensure workspace root + all subdirectories exist
		try { await vscode.workspace.fs.createDirectory(base); } catch (_) {}
		const sortedDirs = Array.from(dirs).sort();
		for (const dir of sortedDirs) {
			if (!dir) { continue; }
			try {
				await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(base, dir));
			} catch (_) {}
		}

		// Write every file
		for (const kv of entries) {
			const rel = kv[0].slice(stripPrefix.length);
			if (!rel) { continue; }
			const content = await kv[1].async('uint8array');
			await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(base, rel), content);
		}

		status.text = '$(check) ' + entries.length + ' files loaded';
		setTimeout(function() { status.dispose(); }, 4000);
		vscode.window.showInformationMessage(
			'Workspace loaded: ' + entries.length + ' file(s) from ZIP.'
		);
	} catch (err) {
		console.error('[workspace-loader] ERROR:', err);
		status.text = '$(error) ZIP load failed';
		vscode.window.showErrorMessage('workspace-loader: ' + String(err));
	}
};

exports.deactivate = function deactivate() {};
`;

	fs.writeFileSync(path.join(extDir, 'extension.js'), extensionJs);
}

/** List all *.css files under a directory (relative paths). */
function findCssModules(dir) {
	const results = [];
	function walk(current, rel) {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				walk(path.join(current, entry.name), rel + entry.name + '/');
			} else if (entry.name.endsWith('.css')) {
				results.push(rel + entry.name);
			}
		}
	}
	walk(dir, '');
	return results;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

console.log(`Packaging VS Code web OPTIMIZED static build to: ${dest}`);

// Validate prerequisite
if (!fs.existsSync(path.join(OPTIMIZED_SRC, 'out', 'vs', 'workbench', 'workbench.web.main.internal.js'))) {
	console.error('Error: ../vscode-web/ is not populated. Run "npm run gulp vscode-web-min" first.');
	process.exit(1);
}

// Clean destination
if (fs.existsSync(dest)) {
	fs.rmSync(dest, { recursive: true });
}
fs.mkdirSync(dest, { recursive: true });

// 1. Copy the entire optimized build
console.log('  Copying ../vscode-web/ ...');
cpSync(OPTIMIZED_SRC, dest);

// 1b. Copy resources/server/ for favicons/manifest
const serverResources = path.join(REPO_ROOT, 'resources', 'server');
if (fs.existsSync(serverResources)) {
	const destResources = path.join(dest, 'resources', 'server');
	fs.mkdirSync(destResources, { recursive: true });
	cpSync(serverResources, destResources);
	console.log('  Copied resources/server/ (icons, manifest)');
}

// 2. Patch webview index.html for plain static server usage:
//    - Skip hostname validation (a plain static server can't serve on uuid subdomains)
//    - Update CSP to allow the modified inline script
console.log('  Patching webview pre/index.html ...');
const webviewIndexPath = path.join(dest, 'out', 'vs', 'workbench', 'contrib', 'webview', 'browser', 'pre', 'index.html');
if (fs.existsSync(webviewIndexPath)) {
	let webviewHtml = fs.readFileSync(webviewIndexPath, 'utf8');
	// Skip hostname/hash validation for same-origin serving
	webviewHtml = webviewHtml.replace(
		/if \(hostname === parentOriginHash \|\| hostname\.startsWith\(parentOriginHash \+ '\.'\)\) \{/,
		'if (true) {'
	);
	// Replace CSP script-src hash with 'unsafe-inline' since the script content changed
	// and the original sha256 hash no longer matches. This is acceptable for local dev.
	webviewHtml = webviewHtml.replace(
		/script-src 'sha256-[^']+' 'self'/,
		"script-src 'unsafe-inline' 'self'"
	);
	fs.writeFileSync(webviewIndexPath, webviewHtml);
}

// 3. Generate the workbench.js bootstrapper
//    The optimized 'web' build only bundles workbench.web.main.internal.js (exports `create`)
//    but not the shell at vs/code/browser/workbench/workbench.js (that's only in 'server-web').
//    We generate a self-contained bootstrapper that imports `create` from the bundle.
console.log('  Generating workbench.js bootstrapper ...');
const workbenchBootstrapDir = path.join(dest, 'out', 'vs', 'code', 'browser', 'workbench');
fs.mkdirSync(workbenchBootstrapDir, { recursive: true });

const workbenchBootstrapJs = `// Generated by package-web-static-optimized.js
// Self-contained bootstrapper for the optimized static VS Code web build.
// Imports 'create' from the bundled workbench and wires up config + workspace provider.
import { create, URI } from '../../../workbench/workbench.web.main.internal.js';

class WorkspaceProvider {
	static create(config) {
		let workspace;
		let foundWorkspace = false;
		const payload = Object.create(null);
		const query = new URL(document.location.href).searchParams;
		query.forEach((value, key) => {
			switch (key) {
				case 'folder':
					if (config.remoteAuthority && value.startsWith('/')) {
						workspace = { folderUri: URI.from({ scheme: 'vscode-remote', path: value, authority: config.remoteAuthority }) };
					} else {
						workspace = { folderUri: URI.parse(value) };
					}
					foundWorkspace = true;
					break;
				case 'workspace':
					if (config.remoteAuthority && value.startsWith('/')) {
						workspace = { workspaceUri: URI.from({ scheme: 'vscode-remote', path: value, authority: config.remoteAuthority }) };
					} else {
						workspace = { workspaceUri: URI.parse(value) };
					}
					foundWorkspace = true;
					break;
				case 'ew':
					workspace = undefined;
					foundWorkspace = true;
					break;
				case 'payload':
					try { Object.assign(payload, JSON.parse(value)); } catch {}
					break;
			}
		});
		if (!foundWorkspace) {
			if (config.folderUri) { workspace = { folderUri: URI.revive(config.folderUri) }; }
			else if (config.workspaceUri) { workspace = { workspaceUri: URI.revive(config.workspaceUri) }; }
		}
		return new WorkspaceProvider(workspace, payload);
	}

	constructor(workspace, payload) {
		this.workspace = workspace;
		this.payload = payload;
		this.trusted = true;
	}

	async open(workspace, options) {
		const targetHref = this._createTargetUrl(workspace, options);
		if (targetHref) {
			if (options?.reuse) {
				window.location.href = targetHref;
				return true;
			} else {
				return !!window.open(targetHref);
			}
		}
		return false;
	}

	_createTargetUrl(workspace, options) {
		let targetHref;
		if (!workspace) {
			targetHref = document.location.origin + document.location.pathname + '?ew=true';
		} else if (workspace.folderUri) {
			targetHref = document.location.origin + document.location.pathname + '?folder=' + encodeURIComponent(workspace.folderUri.toString(true));
		} else if (workspace.workspaceUri) {
			targetHref = document.location.origin + document.location.pathname + '?workspace=' + encodeURIComponent(workspace.workspaceUri.toString(true));
		}
		if (targetHref && options?.payload) {
			targetHref += '&payload=' + encodeURIComponent(JSON.stringify(options.payload));
		}
		return targetHref;
	}

	hasRemote() {
		if (this.workspace) {
			const uri = this.workspace.folderUri || this.workspace.workspaceUri;
			return uri?.scheme === 'vscode-remote';
		}
		return true;
	}
}

class LocalStorageSecretStorageProvider {
	constructor() {
		this.type = 'persisted';
		this._storageKey = 'secrets.provider';
	}
	async get(key) {
		const secrets = JSON.parse(localStorage.getItem(this._storageKey) || '{}');
		return secrets[key];
	}
	async set(key, value) {
		const secrets = JSON.parse(localStorage.getItem(this._storageKey) || '{}');
		secrets[key] = value;
		localStorage.setItem(this._storageKey, JSON.stringify(secrets));
	}
	async delete(key) {
		const secrets = JSON.parse(localStorage.getItem(this._storageKey) || '{}');
		delete secrets[key];
		localStorage.setItem(this._storageKey, JSON.stringify(secrets));
	}
	async keys() {
		return Object.keys(JSON.parse(localStorage.getItem(this._storageKey) || '{}'));
	}
}

(function () {
	const configElement = document.getElementById('vscode-workbench-web-configuration');
	const configElementAttribute = configElement ? configElement.getAttribute('data-settings') : undefined;
	if (!configElement || !configElementAttribute) {
		throw new Error('Missing web configuration element');
	}
	const config = JSON.parse(configElementAttribute);

	// Resolve _additionalBuiltinExtensionPaths to additionalBuiltinExtensions URIs
	if (config._additionalBuiltinExtensionPaths && Array.isArray(config._additionalBuiltinExtensionPaths)) {
		config.additionalBuiltinExtensions = (config.additionalBuiltinExtensions || []).concat(
			config._additionalBuiltinExtensionPaths.map(p => {
				const url = new URL(p, window.location.href);
				return {
					scheme: url.protocol.slice(0, -1), // remove ':'
					authority: url.host,
					path: url.pathname,
				};
			})
		);
		delete config._additionalBuiltinExtensionPaths;
	}

	create(document.body, {
		...config,
		windowIndicator: config.windowIndicator ?? { label: '\$(remote)', tooltip: 'Code Web' },
		settingsSyncOptions: config.settingsSyncOptions ? { enabled: config.settingsSyncOptions.enabled } : undefined,
		workspaceProvider: WorkspaceProvider.create(config),
		secretStorageProvider: new LocalStorageSecretStorageProvider(),
	});
})();
`;

fs.writeFileSync(path.join(workbenchBootstrapDir, 'workbench.js'), workbenchBootstrapJs);

// 4. Bundle the workspace-loader web extension for ZIP-based workspace loading
console.log('  Bundling workspace-loader extension ...');
bundleWorkspaceLoaderExtension(dest);

// 5. Scan extensions for the builtin extensions metadata
console.log('  Scanning extensions ...');
const builtinExtensions = scanExtensions(path.join(dest, 'extensions'));

// 6. Build product configuration
const product = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'product.json'), 'utf8'));
const commit = execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

const workbenchConfig = {
	productConfiguration: {
		...product,
		// The optimized bundle has a commit hash baked in via BUILD->INSERT_PRODUCT_CONFIGURATION.
		// We must override it to null (not undefined!) because JSON.stringify drops undefined
		// values, so mixin() would never overwrite the baked-in commit.  With null, the key
		// is present in the JSON, mixin() sets commit=null, and isBuilt (!!null) is false,
		// which makes the builtin extension scanner read from the DOM <meta> tag.
		commit: null,
		date: new Date().toISOString(),
		enableTelemetry: false,
	},
};

// 7. Find CSS modules for import map
console.log('  Scanning CSS modules ...');
const cssModules = findCssModules(path.join(dest, 'out'));

// 8. Generate static HTML
console.log('  Generating index.html ...');
const configJSON = JSON.stringify(workbenchConfig).replace(/"/g, '&quot;');
const extensionsJSON = JSON.stringify(builtinExtensions).replace(/"/g, '&quot;');
const cssModulesJSON = JSON.stringify(cssModules);

const html = `<!-- Copyright (C) Microsoft Corporation. All rights reserved. -->
<!DOCTYPE html>
<html>
	<head>
		<script>
			performance.mark('code/didStartRenderer');
		</script>
		<meta charset="utf-8" />

		<!--
		  ZIP WORKSPACE LOADER
		  ====================
		  Open a ZIP file as a workspace by appending ?zip=<url> to this page:
		    http://localhost:8080/?zip=http://example.com/project.zip
		    http://localhost:8080/?zip=./myproject.zip          (same server)
		    http://localhost:8080/?zip=https://codeload.github.com/user/repo/zip/refs/heads/main

		  The startup script below auto-adds "?folder=tmp%3A%2F%2F%2Fworkspace" to
		  the URL so VS Code opens the in-memory workspace folder on first load.
		  The bundled "workspace-loader" extension then fetches the ZIP and writes
		  every file into tmp:///workspace/ using VS Code's built-in tmp:// filesystem.
		  Files survive until the page is reloaded (in-memory only, not persisted).
		-->

		<!-- Auto-redirect: add folder=tmp:/workspace when ?zip= is present -->
		<!-- If no params at all, check for default.zip and load it automatically -->
		<!-- Note: VS Code's URI parser normalises tmp:///workspace → tmp:/workspace (empty authority + absolute path) -->
		<script>
			(function () {
				var p = new URLSearchParams(window.location.search);
				if (p.has('zip') && !p.has('folder') && !p.has('workspace') && !p.has('ew')) {
					p.set('folder', 'tmp:/workspace');
					window.location.replace(window.location.pathname + '?' + p.toString());
				} else if (!p.has('zip') && !p.has('folder') && !p.has('workspace') && !p.has('ew')) {
					// No parameters at all — check if default.zip exists and load it
					var xhr = new XMLHttpRequest();
					xhr.open('HEAD', './default.zip', true);
					xhr.onreadystatechange = function () {
						if (xhr.readyState === 4 && xhr.status === 200) {
							window.location.replace(window.location.pathname + '?zip=./default.zip&folder=tmp%3A%2Fworkspace');
						}
					};
					xhr.send();
				}
			})();
		</script>

		<!-- Mobile tweaks -->
		<meta name="mobile-web-app-capable" content="yes" />
		<meta name="apple-mobile-web-app-capable" content="yes" />
		<meta name="apple-mobile-web-app-title" content="Code">
		<link rel="apple-touch-icon" href="resources/server/code-192.png" />

		<!-- Disable pinch zooming -->
		<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">

		<!-- Workbench Configuration -->
		<meta id="vscode-workbench-web-configuration" data-settings="${configJSON}">

		<!-- Workbench Auth Session -->
		<meta id="vscode-workbench-auth-session" data-settings="">

		<!-- Builtin Extensions -->
		<meta id="vscode-workbench-builtin-extensions" data-settings="${extensionsJSON}">

		<!-- Workbench Icon/Manifest/CSS -->
		<link rel="icon" href="resources/server/favicon.ico" type="image/x-icon" />
		<link rel="manifest" href="resources/server/manifest.json" crossorigin="use-credentials" />
		<link rel="stylesheet" href="out/vs/workbench/workbench.web.main.internal.css">
		<style id="vscode-css-modules" type="text/css" media="screen"></style>

	</head>

	<body aria-label="">
	</body>

	<!-- Startup -->
	<script>
		const baseUrl = new URL('.', window.location.href).toString().replace(/\\/$/, '');
		globalThis._VSCODE_FILE_ROOT = baseUrl + '/out/';

		// Patch product config so webviews load from same origin (avoids CORS with plain static servers).
		// Also inject ?zip= URL param into configurationDefaults so the workspace-loader extension
		// (which runs in a Web Worker without 'window') can read it via vscode.workspace.getConfiguration.
		// IMPORTANT: resolve the zip URL to absolute here (main window has correct base URL);
		// the Web Worker's base URL is a blob/iframe URL where relative paths don't resolve.
		(function() {
			const el = document.getElementById('vscode-workbench-web-configuration');
			if (el) {
				const config = JSON.parse(el.getAttribute('data-settings'));
				config.webviewEndpoint = baseUrl + '/out/vs/workbench/contrib/webview/browser/pre/';
				config.productConfiguration.webviewContentExternalBaseUrlTemplate = baseUrl + '/out/vs/workbench/contrib/webview/browser/pre/';
				const zipParam = new URLSearchParams(window.location.search).get('zip');
				if (zipParam) {
					// Resolve relative → absolute using the main window location
					const absoluteZipUrl = new URL(zipParam, window.location.href).href;
					config.configurationDefaults = config.configurationDefaults || {};
					config.configurationDefaults['workspaceLoader.zipUrl'] = absoluteZipUrl;
				}
				el.setAttribute('data-settings', JSON.stringify(config));
			}
		})();
	</script>
	<script>
		const sheet = document.getElementById('vscode-css-modules').sheet;
		globalThis._VSCODE_CSS_LOAD = function (url) {
			sheet.insertRule(\`@import url(\${url});\`);
		};

		const importMap = { imports: {} };
		const cssModules = ${cssModulesJSON};
		for (const cssModule of cssModules) {
			const cssUrl = new URL(cssModule, globalThis._VSCODE_FILE_ROOT).href;
			const jsSrc = \`globalThis._VSCODE_CSS_LOAD('\${cssUrl}');\\n\`;
			const blob = new Blob([jsSrc], { type: 'application/javascript' });
			importMap.imports[cssUrl] = URL.createObjectURL(blob);
		}
		const importMapElement = document.createElement('script');
		importMapElement.type = 'importmap';
		importMapElement.setAttribute('nonce', '1nline-m4p');
		importMapElement.textContent = JSON.stringify(importMap, undefined, 2);
		document.head.appendChild(importMapElement);
	</script>
	<script>
		performance.mark('code/willLoadWorkbenchMain');
	</script>
	<script type="module" src="out/nls.messages.js"></script>
	<script type="module" src="out/vs/code/browser/workbench/workbench.js"></script>
</html>
`;

fs.writeFileSync(path.join(dest, 'index.html'), html);

// 9. Create demo ZIP for testing the workspace loader
console.log('  Creating demo.zip ...');
const JSZip = require('jszip');
const demoZip = new JSZip();
const demoFolder = demoZip.folder('demo-project');
demoFolder.file('README.md', '# Demo Project\n\nThis is a demo project loaded from a ZIP file into VS Code Web.\n\n## Getting Started\n\nEdit any file — changes are kept in-memory (lost on page reload).\n');
demoFolder.file('index.html', '<!DOCTYPE html>\n<html lang="en">\n<head>\n\t<meta charset="UTF-8">\n\t<title>Hello World</title>\n\t<link rel="stylesheet" href="style.css">\n</head>\n<body>\n\t<h1>Hello from VS Code Web!</h1>\n\t<p>This page was loaded from a ZIP file.</p>\n\t<script src="app.js"></script>\n</body>\n</html>\n');
demoFolder.file('style.css', 'body {\n\tfont-family: system-ui, sans-serif;\n\tmax-width: 800px;\n\tmargin: 2rem auto;\n\tpadding: 0 1rem;\n\tcolor: #333;\n\tbackground: #fafafa;\n}\n\nh1 {\n\tcolor: #0066cc;\n}\n');
demoFolder.file('app.js', '\'use strict\';\n\nconsole.log(\'Hello from VS Code Web!\');\n\ndocument.addEventListener(\'DOMContentLoaded\', () => {\n\tconst p = document.querySelector(\'p\');\n\tif (p) {\n\t\tp.textContent += \' Loaded at: \' + new Date().toLocaleTimeString();\n\t}\n});\n');
demoFolder.file('.vscode/settings.json', '{\n\t"editor.tabSize": 2,\n\t"editor.formatOnSave": true\n}\n');
demoZip.generateAsync({ type: 'nodebuffer' }).then(buf => {
	fs.writeFileSync(path.join(dest, 'demo.zip'), buf);
});

// 9b. Create default.zip — auto-loaded when visiting without URL parameters
console.log('  Creating default.zip ...');
const defaultZip = new JSZip();
const defaultReadme = `# VS Code Web — Static Build

This is [Visual Studio Code](https://code.visualstudio.com/) running entirely
in your browser as a static website.

- **Completely served by a static web server** (e.g. \`python3 -m http.server 8080\`)
- **Everything runs in the browser** — no backend, no Node.js runtime required
- It only needs a web server to serve the HTML and JavaScript as static files

## Author

Christian Jann <christian.jann@ymail.com>

## Source Code

https://github.com/christianjann/vscode-web

## Loading a Workspace

Via URL you can load a ZIP file into the workspace:

### Any ZIP served from the same server:
\`\`\`
http://localhost:8080/?zip=./myproject.zip
\`\`\`

### GitHub repo ZIP (public):
\`\`\`
http://localhost:8080/?zip=https://codeload.github.com/USERNAME/REPO/zip/refs/heads/main
\`\`\`

### Default workspace:
If a \`default.zip\` file exists in the served directory, it is loaded
automatically when visiting the page without any URL parameters.

To customize the default workspace, simply replace \`default.zip\` with
your own ZIP file.

## How It Works

The page redirects once (adding \`&folder=tmp%3A%2F%2F%2Fworkspace\`),
VS Code opens the empty in-memory folder, then the workspace-loader
extension fetches + unpacks the ZIP and populates it — you\u2019ll see a
progress item in the status bar and a notification when done.

Files are editable but **in-memory only** (lost on reload).

## Open a Local Folder

In Chrome or Edge, you can also use **File > Open Folder** to open a
local directory directly from disk (using the File System Access API).
`;
defaultZip.file('README.md', defaultReadme);
defaultZip.generateAsync({ type: 'nodebuffer' }).then(buf => {
	fs.writeFileSync(path.join(dest, 'default.zip'), buf);
});

// 10. Print summary
const totalSize = execSync(`du -sh "${dest}"`, { encoding: 'utf8' }).trim().split('\t')[0];
console.log(`\nDone! Total size: ${totalSize}`);
console.log(`\nTo serve it:\n  cd ${dest}\n  python3 -m http.server 8080`);
console.log(`\nOpen a local file system folder (Chrome/Edge only):\n  http://localhost:8080/`);
console.log(`\nDefault workspace (auto-loaded when visiting without params):\n  default.zip is included — replace it with your own to customize`);
console.log(`\nOpen the bundled demo project:\n  http://localhost:8080/?zip=./demo.zip`);
console.log(`\nOpen any ZIP as an in-memory workspace:\n  http://localhost:8080/?zip=./myproject.zip`);
console.log(`  http://localhost:8080/?zip=https://codeload.github.com/USER/REPO/zip/refs/heads/main`);
