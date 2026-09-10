import test from "node:test";
import { checkErrorEmitterInventory } from "../error-emitter-inventory.mjs";

test("known error emitters match the reviewed classification coverage fixture", checkErrorEmitterInventory);
