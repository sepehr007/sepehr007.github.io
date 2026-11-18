import "dotenv/config";
import { appConfig, configWarnings, publicConfig } from "./config.js";

const warnings = configWarnings();
const errors = warnings.filter((warning) => warning.level === "error");

console.log(
  JSON.stringify(
    {
      ok: errors.length === 0,
      ...publicConfig(),
      storage: {
        dataDir: appConfig.dataDir,
        sqliteFile: appConfig.sqliteFile,
        backupDir: appConfig.backupDir
      },
      integrations: {
        mongo: Boolean(process.env.MONGO_URI),
        redis: Boolean(process.env.REDIS_URL),
        mail: Boolean(process.env.SMTP_HOST),
        sms: Boolean(process.env.SMS_PROVIDER)
      },
      warnings
    },
    null,
    2
  )
);

process.exitCode = errors.length ? 1 : 0;
