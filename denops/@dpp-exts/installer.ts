import {
  Actions,
  BaseExt,
  DppOptions,
  Plugin,
  Protocol,
  ProtocolName,
} from "https://deno.land/x/dpp_vim@v0.0.6/types.ts";
import {
  Denops,
  fn,
  op,
  vars,
} from "https://deno.land/x/dpp_vim@v0.0.6/deps.ts";
import {
  convert2List,
  isDirectory,
} from "https://deno.land/x/dpp_vim@v0.0.6/utils.ts";

type Params = {
  checkDiff: boolean;
};

type InstallParams = {
  names: string[];
};

export class Ext extends BaseExt<Params> {
  override actions: Actions<Params> = {
    build: {
      description: "Build plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: unknown;
      }) => {
        const params = args.actionParams as InstallParams;

        const plugins = await getPlugins(args.denops, params.names ?? []);

        for (const plugin of plugins) {
          await buildPlugin(args.denops, plugin);
        }
      },
    },
    install: {
      description: "Install plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: unknown;
      }) => {
        const params = args.actionParams as InstallParams;
        const plugins = await getPlugins(args.denops, params.names ?? []);

        const bits = await Promise.all(
          plugins.map(async (plugin) =>
            plugin.path && !await isDirectory(plugin.path)
          ),
        );

        await updatePlugins(args, plugins.filter((_) => bits.shift()));
      },
    },
    update: {
      description: "Update plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: unknown;
      }) => {
        const params = args.actionParams as InstallParams;
        await updatePlugins(
          args,
          await getPlugins(args.denops, params.names ?? []),
        );
      },
    },
    reinstall: {
      description: "Reinstall plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: unknown;
      }) => {
        const params = args.actionParams as InstallParams;
        if (!params.names || params.names.length === 0) {
          // NOTE: names must be set.
          await args.denops.call(
            "dpp#util#_error",
            "names must be set for reinstall plugins.",
          );
          return;
        }

        const plugins = await getPlugins(args.denops, params.names ?? []);

        for (const plugin of plugins) {
          // Remove plugin directory
          if (plugin.path && await isDirectory(plugin.path)) {
            await Deno.remove(plugin.path, { recursive: true });
          }
        }

        await updatePlugins(args, plugins);
      },
    },
  };

  override params(): Params {
    return {
      checkDiff: false,
    };
  }
}

async function updatePlugins(args: {
  denops: Denops;
  options: DppOptions;
  protocols: Record<ProtocolName, Protocol>;
  extParams: Params;
  actionParams: unknown;
}, plugins: Plugin[]) {
  if (plugins.length === 0) {
    await args.denops.call(
      "dpp#util#_error",
      "Target plugins are not found.",
    );
    await args.denops.call(
      "dpp#util#_error",
      "You may have used the wrong plugin name," +
        " or all of the plugins are already installed.",
    );
    return;
  }

  const updatedPlugins = [];
  const oldRevisions: Record<string, string> = {};
  let count = 1;
  for (const plugin of plugins) {
    await args.denops.call(
      "dpp#ext#installer#_print_progress_message",
      `[${count}/${plugins.length}] ${plugin.name}`,
    );

    const protocol = args.protocols[plugin.protocol ?? ""];

    oldRevisions[plugin.name] = await protocol.protocol.getRevision({
      denops: args.denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
    });

    const commands = await protocol.protocol.getSyncCommands({
      denops: args.denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
    });

    // Execute commands
    for (const command of commands) {
      const proc = new Deno.Command(
        command.command,
        {
          args: command.args,
          cwd: await isDirectory(plugin.path ?? "") ? plugin.path : Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        },
      );

      const { stdout, stderr, success } = await proc.output();

      for (
        const line of new TextDecoder().decode(stdout).split(/\r?\n/).filter((
          line,
        ) => line.length > 0)
      ) {
        await args.denops.call(
          "dpp#ext#installer#_print_progress_message",
          line,
        );
      }

      for (
        const line of new TextDecoder().decode(stderr).split(/\r?\n/).filter((
          line,
        ) => line.length > 0)
      ) {
        await args.denops.call(
          "dpp#ext#installer#_print_progress_message",
          line,
        );
      }

      if (success) {
        // Execute "post_update" before "build"
        if (plugin.hook_post_update) {
          await args.denops.call(
            "dpp#ext#installer#_call_hook",
            "post_update",
            plugin,
          );
        }

        await buildPlugin(args.denops, plugin);

        updatedPlugins.push(plugin);
      }
    }

    count += 1;
  }

  const calledDepends: Record<string, boolean> = {};
  for (const plugin of updatedPlugins) {
    if (plugin.hook_done_update) {
      await args.denops.call(
        "dpp#ext#installer#_call_hook",
        "done_update",
        plugin,
      );
    }

    for (
      const depend of await getPlugins(
        args.denops,
        convert2List(plugin.depends),
      )
    ) {
      if (depend.hook_depends_update && !calledDepends[depend.name]) {
        calledDepends[depend.name] = true;

        await args.denops.call(
          "dpp#ext#installer#_call_hook",
          "depends_update",
          depend,
        );
      }
    }

    if (args.extParams.checkDiff) {
      const protocol = args.protocols[plugin.protocol ?? ""];
      const newRev = await protocol.protocol.getRevision({
        denops: args.denops,
        plugin,
        protocolOptions: protocol.options,
        protocolParams: protocol.params,
      });

      await checkDiff(
        args.denops,
        plugin,
        args.protocols[plugin.protocol ?? ""],
        oldRevisions[plugin.name],
        newRev,
      );
    }
  }

  await args.denops.call("dpp#ext#installer#_close_progress_window");

  await args.denops.call("dpp#clear_state");
}

async function getPlugins(
  denops: Denops,
  names: string[],
): Promise<Plugin[]> {
  // NOTE: Skip local plugins
  let plugins = (Object.values(
    await vars.g.get(
      denops,
      "dpp#_plugins",
    ),
  ) as Plugin[]).filter((plugin) => !plugin.local);

  if (names.length > 0) {
    plugins = plugins.filter((plugin) => names.indexOf(plugin.name) >= 0);
  }

  return plugins;
}

async function buildPlugin(
  denops: Denops,
  plugin: Plugin,
) {
  if (!plugin.path || !await isDirectory(plugin.path) || !plugin.build) {
    return;
  }

  const proc = new Deno.Command(
    await op.shell.getGlobal(denops),
    {
      args: [await op.shellcmdflag.getGlobal(denops), plugin.build],
      cwd: plugin.path,
      stdout: "piped",
      stderr: "piped",
    },
  );

  const { stdout, stderr } = await proc.output();

  for (
    const line of new TextDecoder().decode(stdout).split(/\r?\n/).filter((
      line,
    ) => line.length > 0)
  ) {
    await denops.call(
      "dpp#ext#installer#_print_progress_message",
      line,
    );
  }

  for (
    const line of new TextDecoder().decode(stderr).split(/\r?\n/).filter((
      line,
    ) => line.length > 0)
  ) {
    await denops.call(
      "dpp#ext#installer#_print_progress_message",
      line,
    );
  }
}

async function checkDiff(
  denops: Denops,
  plugin: Plugin,
  protocol: Protocol,
  newRev: string,
  oldRev: string,
) {
  if (newRev === oldRev || newRev.length === 0 || oldRev.length === 0) {
    return;
  }

  const commands = await protocol.protocol.getDiffCommands({
    denops: denops,
    plugin,
    protocolOptions: protocol.options,
    protocolParams: protocol.params,
    newRev,
    oldRev,
  });

  for (const command of commands) {
    const proc = new Deno.Command(
      command.command,
      {
        args: command.args,
        cwd: await isDirectory(plugin.path ?? "") ? plugin.path : Deno.cwd(),
        stdout: "piped",
        stderr: "piped",
      },
    );

    const { stdout, stderr } = await proc.output();

    for (const line of new TextDecoder().decode(stdout).split(/\r?\n/)) {
      await outputCheckDiff(denops, line);
    }

    for (const line of new TextDecoder().decode(stderr).split(/\r?\n/)) {
      await outputCheckDiff(denops, line);
    }
  }
}

async function outputCheckDiff(denops: Denops, line: string) {
  if (line.length === 0) {
    return;
  }

  const bufname = "dein-diff";
  const bufnr = await fn.bufexists(denops, bufname)
    ? await fn.bufnr(denops, bufname)
    : await fn.bufadd(denops, bufname);

  if (await fn.bufwinnr(denops, bufnr) < 0) {
    const cmd = await fn.escape(
      denops,
      "setlocal bufhidden=wipe filetype=diff buftype=nofile nolist | syntax enable",
      " "
    );
    await denops.cmd(`sbuffer +${cmd} ${bufnr}`);
  }

  await fn.appendbufline(denops, bufnr, "$", line);
}
