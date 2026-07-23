import "dotenv/config";
import { defineConfig } from "prisma/config";
import { PrismaPg } from "@prisma/adapter-pg";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    adapter: "better-sqlite3",
    url: "file:./prisma/dev.db"
  },
});
