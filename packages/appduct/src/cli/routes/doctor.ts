/** Route for `appduct doctor` — loaded by `cli/dispatch.ts`'s router only when it runs. */

import type { Route } from "../router.js";

import { handleDoctorCommand } from "../../commands/doctor.js";
import { commandName } from "../router.js";
import { executeCommand } from "../runner.js";

export const route: Route = async (context) => {
  const { options } = context;

  return executeCommand(
    commandName(context),
    () =>
      handleDoctorCommand({
        artifactPath: context.args[0],
        assertPresent: Boolean(options.assertPresent),
        assertAbsent: Boolean(options.assertAbsent),
      }),
    context.env,
  );
};
