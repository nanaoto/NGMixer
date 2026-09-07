import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeConfig(
  directory: string,
  overrides: { runtimeRoot?: string; audioWorkRoot?: string; apiKeyEnv?: string } = {},
): Promise<string> {
  const runtimeRoot = overrides.runtimeRoot ?? join(directory, "runtime");
  const audioWorkRoot = overrides.audioWorkRoot ?? join(directory, "audio");
  const apiKeyEnv = overrides.apiKeyEnv ?? "RMA_TEST_KEY";
  const configPath = join(directory, "local.toml");
  await mkdir(directory, { recursive: true });
  await writeFile(
    configPath,
    `[paths]\nreaper_executable = "/Applications/REAPER.app"\nffmpeg_executable = "/opt/homebrew/bin/ffmpeg"\nreaper_resource_path = "${directory}/reaper-resource"\nruntime_root = "${runtimeRoot}"\naudio_work_root = "${audioWorkRoot}"\n\n[network]\ndaemon_host = "127.0.0.1"\ndaemon_port = 32180\ndsh_host = "localhost"\ndsh_port = 3080\n\n[llm.default]\nprovider = "primary"\nmodel = "test-model"\n\n[llm.mix_planner]\nprovider = "primary"\nmodel = "test-model"\n\n[llm.providers.primary]\napi = "openai-completions"\nbase_url = "https://example.invalid/v1"\napi_key_env = "${apiKeyEnv}"\n\n[[llm.providers.primary.models]]\nid = "test-model"\n\n[reaper]\npoll_interval_ms = 10\ncommand_timeout_ms = 200\nrender_timeout_ms = 1000\n\n[safety]\nallow_network_audio_upload = false\nallow_source_media_write = false\nallow_gui_coordinate_control = false\n`,
    "utf8",
  );
  return configPath;
}
