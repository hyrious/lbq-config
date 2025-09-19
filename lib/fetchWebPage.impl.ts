// https://github.com/microsoft/vscode/blob/-/src/vs/platform/webContentExtractor/electron-main/webContentExtractorService.ts

import { URI } from 'vscode-uri';
import { app, BrowserWindow } from 'electron'
import { convertAXTreeToMarkdown } from './cdpAccessibilityDomain.ts';

const uri = process.argv[2]

app.whenReady().then(async () => {
	const win = new BrowserWindow({
		width: 800, height: 600,
		show: false,
		webPreferences: {
			javascript: true,
			offscreen: true,
			sandbox: true,
			webgl: false
		}
	})
	try {
		await win.loadURL(uri)
		win.webContents.debugger.attach('1.1')
		const result = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
		console.log(convertAXTreeToMarkdown(URI.parse(uri), result.nodes))
	} catch (err) {
		console.error(err)
	} finally {
		win.destroy()
	}
})
