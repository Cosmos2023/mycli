import { cpSync, mkdirSync } from "node:fs";

const source = new URL("../../../../src/mycli/prompts/templates/system.md", import.meta.url);
const destination = new URL("../dist/assets/system.md", import.meta.url);

mkdirSync(new URL("../dist/assets/", import.meta.url), { recursive: true });
cpSync(source, destination);
