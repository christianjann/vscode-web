// package-web-static-with-dummy-extension.js
// Patches an existing static VS Code web build to add a dummy extension as a built-in
// and configure the open-vsx.org extension gallery.
//
// Uses the `additionalBuiltinExtensions` API — the official VS Code mechanism for
// adding custom built-in extensions to a web build. The extension files are placed
// in the web root, and a URI pointing to them is added to the workbench config.
// The scanner fetches package.json from that URI at startup and loads the extension.
//
// Prerequisites: Run package-web-static-optimized.js first to create ../vscode-web-static-optimized/
// Usage: node scripts/package-web-static-with-dummy-extension.js

const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

const dest = path.resolve(__dirname, '../../vscode-web-static-optimized');
const dummyExtDir = path.join(__dirname, 'dummy-extension');
const vsixName = 'dummy-extension-0.0.1.vsix';
const vsixPath = path.join(dummyExtDir, vsixName);

// 1. Verify the static build exists
if (!fs.existsSync(dest) || !fs.existsSync(path.join(dest, 'index.html'))) {
	console.error(`Static build not found at ${dest}`);
	console.error('Run "node scripts/package-web-static-optimized.js" first.');
	process.exit(1);
}

// 2. Create dummy extension
console.log('Creating dummy extension...');
if (!fs.existsSync(dummyExtDir)) fs.mkdirSync(dummyExtDir);
fs.writeFileSync(path.join(dummyExtDir, 'package.json'), JSON.stringify({
	name: 'dummy-extension',
	displayName: 'Dummy Extension',
	description: 'A minimal extension for demo purposes.',
	version: '0.0.1',
	publisher: 'local',
	engines: { vscode: '^1.80.0' },
	main: './extension.js',
	browser: './extension.js',
	contributes: {
		commands: [{ command: 'dummy.helloWorld', title: 'Hello World from Dummy' }]
	},
	activationEvents: ['onCommand:dummy.helloWorld'],
	repository: {
		type: 'git',
		url: 'https://github.com/christianjann/vscode-web'
	},
	license: 'MIT'
}, null, 2));
// Always create LICENSE.txt
fs.writeFileSync(path.join(dummyExtDir, 'LICENSE.txt'), `MIT License\n\nCopyright (c) 2026 Christian Jann\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`);
fs.writeFileSync(path.join(dummyExtDir, 'extension.js'), `exports.activate = function(context) {
  const vscode = require('vscode');
  context.subscriptions.push(
    vscode.commands.registerCommand('dummy.helloWorld', () => {
      vscode.window.showInformationMessage('Hello from Dummy Extension!');
    })
  );
};
`);

// 3. Package as VSIX
console.log('Packaging dummy extension as VSIX...');
try {
	child_process.execFileSync('npx', ['vsce', 'package'], { cwd: dummyExtDir, stdio: 'inherit' });
} catch (e) {
	console.error('Failed to package VSIX. Make sure @vscode/vsce is installed globally or locally.');
	process.exit(1);
}

// 4. Wait for VSIX to exist, then copy to web root
console.log('Waiting for VSIX to be created...');
const maxWaitMs = 5000;
const waitInterval = 100;
let waited = 0;
while (!fs.existsSync(vsixPath)) {
	if (waited >= maxWaitMs) {
		console.error('VSIX file not found after waiting:', vsixPath);
		process.exit(2);
	}
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitInterval);
	waited += waitInterval;
}
if (!fs.existsSync(dest)) {
	console.log('Destination directory does not exist, creating:', dest);
	fs.mkdirSync(dest, { recursive: true });
}
console.log('Copying VSIX to web root:', vsixPath, '->', path.join(dest, vsixName));
try {
	fs.copyFileSync(vsixPath, path.join(dest, vsixName));
} catch (e) {
	console.error('Failed to copy VSIX:', e);
	console.error('Source exists:', fs.existsSync(vsixPath), 'Dest exists:', fs.existsSync(dest));
	process.exit(3);
}


// 5. Extract VSIX into the web root as a plain extension directory
// The additionalBuiltinExtensions scanner fetches <URI>/package.json at startup,
// so the files just need to be at a URL the browser can reach.
const extOutputDir = path.join(dest, 'additional-extensions', 'dummy-extension');
console.log('Extracting VSIX to:', extOutputDir);
if (fs.existsSync(extOutputDir)) {
	fs.rmSync(extOutputDir, { recursive: true, force: true });
}
fs.mkdirSync(extOutputDir, { recursive: true });
const AdmZip = require('adm-zip');
const zip = new AdmZip(vsixPath);
zip.extractAllTo(extOutputDir, true);
// Move files from extension/ subdirectory up one level (VSIX internal structure)
const extSubdir = path.join(extOutputDir, 'extension');
if (fs.existsSync(extSubdir)) {
	for (const file of fs.readdirSync(extSubdir)) {
		fs.renameSync(path.join(extSubdir, file), path.join(extOutputDir, file));
	}
	fs.rmdirSync(extSubdir);
}
// Remove VSIX-specific metadata files
for (const f of ['[Content_Types].xml', 'extension.vsixmanifest']) {
	const p = path.join(extOutputDir, f);
	if (fs.existsSync(p)) fs.rmSync(p);
}
console.log('Extension extracted. Contents:', fs.readdirSync(extOutputDir));


// 6. Patch index.html and workbench.js to use additionalBuiltinExtensions
// The additionalBuiltinExtensions API accepts UriComponents objects ({ scheme, authority, path })
// but we don't know the scheme/authority at build time (http vs https, which host).
// So we store the extension paths in the config meta tag, and patch the bootstrapper
// to resolve them to full URIs using window.location at runtime.
const indexPath = path.join(dest, 'index.html');
let indexHtml = fs.readFileSync(indexPath, 'utf8');

/**
 * Read the data-settings JSON from a <meta> tag identified by its id.
 */
function readMetaTagSettings(html, metaId) {
	const marker = `id="${metaId}"`;
	const markerIdx = html.indexOf(marker);
	if (markerIdx < 0) return null;
	const dsMarker = 'data-settings="';
	const dsIdx = html.indexOf(dsMarker, markerIdx);
	if (dsIdx < 0) return null;
	const valStart = dsIdx + dsMarker.length;
	const valEnd = html.indexOf('"', valStart);
	if (valEnd < 0) return null;
	return {
		value: JSON.parse(html.substring(valStart, valEnd).replace(/&quot;/g, '"')),
		valStart,
		valEnd,
	};
}

/**
 * Replace the data-settings attribute value of a <meta> tag identified by its id.
 */
function replaceMetaTagSettings(html, metaId, newSettingsObj) {
	const parsed = readMetaTagSettings(html, metaId);
	if (!parsed) {
		console.warn(`Could not find meta tag with id="${metaId}".`);
		return html;
	}
	const newVal = JSON.stringify(newSettingsObj).replace(/"/g, '&quot;');
	return html.substring(0, parsed.valStart) + newVal + html.substring(parsed.valEnd);
}

// Patch the web configuration meta tag
const configMetaId = 'vscode-workbench-web-configuration';
const configParsed = readMetaTagSettings(indexHtml, configMetaId);
if (configParsed) {
	const config = configParsed.value;

	// Store extension paths as a custom property. The bootstrapper will resolve
	// these to full UriComponents at runtime using the page's scheme and host.
	if (!config._additionalBuiltinExtensionPaths) {
		config._additionalBuiltinExtensionPaths = [];
	}
	// Remove any existing dummy-extension entry to make re-runs idempotent
	config._additionalBuiltinExtensionPaths = config._additionalBuiltinExtensionPaths.filter(
		p => !p.includes('dummy-extension')
	);
	config._additionalBuiltinExtensionPaths.push('additional-extensions/dummy-extension');
	console.log('Added dummy-extension path to config:', config._additionalBuiltinExtensionPaths);

	// Add extensionsGallery (open-vsx.org)
	if (config.productConfiguration) {
		config.productConfiguration.extensionsGallery = {
			serviceUrl: 'https://open-vsx.org/vscode/gallery',
			itemUrl: 'https://open-vsx.org/vscode/item',
			resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
			controlUrl: '',
			nlsBaseUrl: '',
			publisherUrl: '',
		};
		// Remove dummy extension from builtInExtensions if present (wrong mechanism)
		if (Array.isArray(config.productConfiguration.builtInExtensions)) {
			config.productConfiguration.builtInExtensions = config.productConfiguration.builtInExtensions.filter(
				e => e.name !== 'dummy-extension'
			);
		}
	}

	indexHtml = replaceMetaTagSettings(indexHtml, configMetaId, config);
	console.log('Patched web configuration: extension paths + extensionsGallery.');
} else {
	console.warn('Could not find vscode-workbench-web-configuration meta tag.');
}

fs.writeFileSync(indexPath, indexHtml);

// 7. Patch workbench.js bootstrapper to resolve _additionalBuiltinExtensionPaths
// into proper additionalBuiltinExtensions UriComponents at runtime.
const workbenchJsPath = path.join(dest, 'out', 'vs', 'code', 'browser', 'workbench', 'workbench.js');
let workbenchJs = fs.readFileSync(workbenchJsPath, 'utf8');

// Find the create() call and inject the resolution code just before it
const createCallMarker = 'create(document.body, {';
const createCallIdx = workbenchJs.indexOf(createCallMarker);
if (createCallIdx >= 0) {
	// Insert code before the create() call to resolve extension paths to URIs
	const resolveCode = `
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

	`;
	workbenchJs = workbenchJs.substring(0, createCallIdx) + resolveCode + workbenchJs.substring(createCallIdx);
	fs.writeFileSync(workbenchJsPath, workbenchJs);
	console.log('Patched workbench.js to resolve additionalBuiltinExtensions URIs at runtime.');
} else {
	console.warn('Could not find create() call in workbench.js — additionalBuiltinExtensions may not work.');
}

console.log('Done! Extension added via additionalBuiltinExtensions, gallery configured with open-vsx.org.');
