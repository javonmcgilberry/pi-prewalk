export interface InstalledDependencyTree {
	dependencies?: Record<string, { version?: string } | undefined>;
}

export function installedDependencies(
	tree: InstalledDependencyTree,
	version: string,
): Record<string, string>;
