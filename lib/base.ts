export type RegisterFunction = {
	(pattern: string | RegExp, run: (arg: RegExpMatchArray, ...args: string[]) => unknown, description?: string): void;
	(pattern: string | RegExp, pattern2: string | RegExp, run: (arg: RegExpMatchArray, arg2: RegExpMatchArray, ...args: string[]) => unknown, description?: string): void;
	(pattern: string | RegExp, pattern2: string | RegExp, pattern3: string | RegExp, run: (arg: RegExpMatchArray, arg2: RegExpMatchArray, arg3: RegExpMatchArray, ...args: string[]) => unknown, description?: string): void;
}
