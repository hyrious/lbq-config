import path from 'node:path'
import spawn from 'nano-spawn'
import electronPath from 'electron'

export async function fetchWebPage(uri: string): Promise<string> {
	const proc = await spawn(
		electronPath as unknown as string,
		[path.join(import.meta.dirname, 'fetchWebPage.impl.ts'), uri]
	)
	return proc.stdout
}
