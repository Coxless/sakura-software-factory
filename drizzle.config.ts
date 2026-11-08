import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/queue/schema.ts",
  out: "./drizzle",
});
