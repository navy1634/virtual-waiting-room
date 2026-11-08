import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GenericContainer, Wait } from "testcontainers";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const databaseRoot = resolve(appRoot, "../db");
const migrationsDirectory = resolve(databaseRoot, "migrations");
const testDatabaseName = "vwr_test";
const testDatabaseUser = "waiting_room";
const postgresImage = "postgres:18.6-alpine";
const inheritedEnvironmentNames = [
  "PATH",
  "LD_LIBRARY_PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "WINDIR",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "TZ",
];

type ChildEnvironment = Record<string, string>;

// dbmate には必要な実行環境だけを渡し、開発用の認証情報を引き継がない
function createChildEnvironment(databaseUrl: string): ChildEnvironment {
  const environment: ChildEnvironment = {};

  for (const name of inheritedEnvironmentNames) {
    const value = process.env[name];

    if (value !== undefined) {
      environment[name] = value;
    }
  }

  environment.DATABASE_URL = databaseUrl;
  return environment;
}

function resolveDbmatePath(): string {
  const result = spawnSync("mise", ["which", "dbmate"], {
    cwd: databaseRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const dbmatePath = result.stdout?.trim();

  if (
    result.error &&
    "code" in result.error &&
    result.error.code === "ENOENT"
  ) {
    throw new Error(
      "mise is unavailable; install the database tools with mise",
    );
  }

  if (result.error || result.status !== 0 || !dbmatePath) {
    throw new Error(
      "dbmate is unavailable; install the database tools with mise",
    );
  }

  return dbmatePath;
}

function createDatabaseUrl(
  host: string,
  port: number,
  password: string,
): string {
  const databaseUrl = new URL(
    `postgres://${testDatabaseUser}@localhost/${testDatabaseName}`,
  );
  databaseUrl.hostname = host;
  databaseUrl.port = String(port);
  databaseUrl.password = password;
  databaseUrl.searchParams.set("sslmode", "disable");

  return databaseUrl.toString();
}

function migrateTestDatabase(databaseUrl: string): void {
  // 生成した URL だけを使い、schema dump を書かず、migration lock を有効にする
  const result = spawnSync(
    resolveDbmatePath(),
    [
      "--env-file",
      "/dev/null",
      "--no-dump-schema",
      "--migration-lock",
      "--migration-lock-timeout",
      "30s",
      "--migrations-dir",
      migrationsDirectory,
      "migrate",
      "--strict",
    ],
    {
      cwd: appRoot,
      env: createChildEnvironment(databaseUrl),
      stdio: "inherit",
    },
  );

  if (result.error || result.status !== 0) {
    throw new Error("Could not migrate the Testcontainers database");
  }
}

export interface TestDatabase {
  url: string;
  environment: {
    DATABASE_HOST: string;
    DATABASE_PORT: string;
    DATABASE_NAME: string;
    DATABASE_USER: string;
    DATABASE_PASSWORD: string;
    DATABASE_SSLMODE: string;
  };
  stop: () => Promise<void>;
}

// Bun unit tests と Playwright は別々に呼ぶが、起動手順はここで共有する
export async function startTestDatabase(): Promise<TestDatabase> {
  const password = randomBytes(32).toString("base64url");
  let stopContainer: (() => Promise<void>) | undefined;

  try {
    const container = await new GenericContainer(postgresImage)
      .withEnvironment({
        POSTGRES_DB: testDatabaseName,
        POSTGRES_USER: testDatabaseUser,
        POSTGRES_PASSWORD: password,
        POSTGRES_INITDB_ARGS: "--auth-host=scram-sha-256",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage("database system is ready to accept connections", 2),
      )
      .start();
    const stop = async (): Promise<void> => {
      await container.stop();
    };
    stopContainer = stop;

    const host = container.getHost();
    const port = container.getMappedPort(5432);
    const environment = {
      DATABASE_HOST: host,
      DATABASE_PORT: String(port),
      DATABASE_NAME: testDatabaseName,
      DATABASE_USER: testDatabaseUser,
      DATABASE_PASSWORD: password,
      DATABASE_SSLMODE: "disable",
    };
    const url = createDatabaseUrl(host, port, password);

    // migration 成功前にテストを始めると、実装の結果ではなく準備不足で失敗する
    migrateTestDatabase(url);

    return { url, environment, stop };
  } catch (error) {
    await stopContainer?.();
    throw error;
  }
}
