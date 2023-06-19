import fs = require('fs');
import path = require('path');
import tl = require('azure-pipelines-task-lib/task');

import { getSystemAccessToken } from 'azure-pipelines-tasks-artifacts-common/webapi';
import { IExecSyncResult } from 'azure-pipelines-task-lib/toolrunner';

import toml = require('toml');

type Result<T, E> =
  | { ok: true, value: T }
  | { ok: false, error: E };

interface TomlError {
  message: string;
  line: number;
  column: number;
}

interface RustConfig {
  registries: {[index: string]: { index: string } | string}
}

function parseToml<T>(data: string): Result<T, TomlError> {
  try {
    return { ok: true, value: toml.parse(data) };
  } catch (e: any) {
    return { ok: false, error: e };
  }
}

function throwIfErr(res: IExecSyncResult, msg?: string) {
  if (res.code != 0) {
    tl.error(`Error code: [${res.code}]: ${msg || 'command failed'}`)
    throw res;
  }
}

function extractOrgName(url: string): string {
  let urlParts = new URL(url);
  if (urlParts.hostname.endsWith('dev.azure.com')) {
    return urlParts.pathname.split('/')[0].toLowerCase();
  } else if (urlParts.hostname.endsWith('visualstudio.com')) {
    let domainParts = urlParts.hostname.split('.');
    if (domainParts.length === 3) {
      return domainParts[0].toLowerCase();
    }
  }

  throw `Unexpected Azure DevOps URL: ${url}`;
}

export class Task {
  public static async runMain(): Promise<void> {
    let toolExecutionError: string | undefined = undefined;
    try {
      // Get the config file
      const configFile = tl.getInput('configFile') ||
        path.join(tl.getTaskVariable('Build.SourcesDirectory') || '',
          '.cargo', 'config.toml');

      const res = parseToml<RustConfig>(fs.readFileSync(configFile).toString());
      if (!res.ok) {
        throw `${configFile}:${res.error.line}:${res.error.column}: ${res.error.message})`;
      }

      // Extract the organization name from each registry
      let registryOrgs: {[index: string]: string} = {};
      for (const registryName in res.value.registries) {
        let registry = res.value.registries[registryName];
        if (typeof(registry) === 'string') {
          registryOrgs[registryName] = extractOrgName(registry);
        } else {
          registryOrgs[registryName] = extractOrgName(registry.index);
        }
      }

      const delimiter = /\s*,\s*/;
      const ourOrg = tl.getInput('internalOrganization') ||
        extractOrgName(tl.getVariable('System.CollectionUri') || '');
      const extnAuth = tl.getInput('externalAuthToken');
      const extnOrgs = tl.getInput('externalOrganizations');
      const extnOrgsList = new Set<string>();
      const ignoreOrgsList = new Set<string>
        (tl.getDelimitedInput('ignoreOrganizations', delimiter));

      // If externalOrganizations is empty, we should assume every
      // organization should be included.
      if (extnOrgs === undefined) {
        for (const registry in registryOrgs) {
          extnOrgsList.add(registryOrgs[registry]);
        }
      } else {
        for (const org of extnOrgs.split(delimiter)) {
          extnOrgsList.add(org);
        }
      }

      // For each registry, we will try to authenticate into it. If the registry
      // is marked as an external registry, we should use our external access
      // token; otherwise, use our own system access token.
      for (const registry in registryOrgs) {
        let authToken: string;
        if (ignoreOrgsList.has(registryOrgs[registry])) {
          tl.debug(`Ignoring registry ${registry}`);
          continue;
        } else if (extnOrgsList.has(registryOrgs[registry])) {
          if (extnAuth === undefined) {
            tl.warning('externalAuthToken must be specified to authenticate to external registries');
            continue;
          }
          authToken = extnAuth;
        } else if (registryOrgs[registry] === ourOrg) {
          authToken = getSystemAccessToken();
        } else {
          tl.warning(`Registry ${registry} was not in the externals list so not logging in!`);
          continue;
        }
        let args = ['login', '--registry', registry, `Bearer ${authToken}`];
        throwIfErr(tl.execSync('cargo', args));
      }
    } catch (err: any) {
      if (err.stderr) {
        toolExecutionError = err.stderr;
      } else {
        toolExecutionError = err;
      }
    }

    if (!!toolExecutionError) {
      tl.setResult(tl.TaskResult.Failed, `Failed to authenticate: ${toolExecutionError}`);
    } else {
      tl.setResult(tl.TaskResult.Succeeded, 'Successfully authenticated into all cargo registries.');
    }
  }
}

Task.runMain();
