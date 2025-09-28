export type RegisterFunction = {
	(pattern: string | RegExp, run: (arg: RegExpMatchArray, ...args: string[]) => unknown, description?: string): void;
	(pattern: string | RegExp, pattern2: string | RegExp, run: (arg: RegExpMatchArray, arg2: RegExpMatchArray, ...args: string[]) => unknown, description?: string): void;
	(pattern: string | RegExp, pattern2: string | RegExp, pattern3: string | RegExp, run: (arg: RegExpMatchArray, arg2: RegExpMatchArray, arg3: RegExpMatchArray, ...args: string[]) => unknown, description?: string): void;
}

/** `^1` &rarr; `1` */
export function cleanVersion(v: string): string {
	return v.replace(/^[^\d]+/, '')
}

/** `try { decodeURIComponent(str) }` */
export function tryUnescape(str: string): string {
	try { return decodeURIComponent(str) }
	catch { return str }
}

/** `https://github.com/...` &rarr; `github.com` */
export function hostname(str: string): string {
	try { return (new URL(str)).hostname }
	catch { return str.split('/')[0] || str }
}

export function anchor(text: string, href: string): string {
	return `\x1b]8;;${href}\x07${text}\x1b]8;;\x07`
}
