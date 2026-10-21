import { test as base } from "e2e";
import { withAppduct } from "@appduct/e2e";

export const test = withAppduct(base);
