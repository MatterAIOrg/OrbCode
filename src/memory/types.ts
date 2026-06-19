/** A loaded memory (AGENTS.md) file with its origin metadata. */
export interface MemoryFile {
	/** Absolute path to the file on disk. */
	path: string
	/** The file's content (with @includes inlined). */
	content: string
	/** Where this memory was loaded from. */
	type: "user" | "project" | "local"
}
