import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(join(root, "dist/web"), { recursive: true });
for (const f of ["index.html", "styles.css"]) {
	await copyFile(join(root, "src/web", f), join(root, "dist/web", f));
}
