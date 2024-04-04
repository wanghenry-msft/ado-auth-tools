import * as path from 'path';
import * as tl from 'azure-pipelines-task-lib/task';
import { installCredProviderToUserProfile, configureCredProvider } from 'azure-pipelines-tasks-artifacts-common/credentialProviderUtils'
import { ProtocolType } from 'azure-pipelines-tasks-artifacts-common/protocols';
import { ServiceConnection, TokenServiceConnection } from 'azure-pipelines-tasks-artifacts-common/serviceConnectionUtils'
import { emitTelemetry } from 'azure-pipelines-tasks-artifacts-common/telemetry'

async function main(): Promise<void> {
  let forceReinstallCredentialProvider = null;
  try {
    tl.setResourcePath(path.join(__dirname, 'task.json'));

    // Install the credential provider
    forceReinstallCredentialProvider = tl.getBoolInput('forceReinstallCredentialProvider', false);
    await installCredProviderToUserProfile(forceReinstallCredentialProvider);

    if (tl.getInput('configFile', false)) {
      tl.setResult(tl.TaskResult.Failed, "Does not support configFile option");
      return;
    }

    if (tl.getInput('externalOrganizations', false)) {
      tl.setResult(tl.TaskResult.Failed, "Does not support externalOrganizations option");
      return;
    }

    if (tl.getInput('internalOrganization', false)) {
      tl.setResult(tl.TaskResult.Failed, "Does not support internalOrganization option");
      return;
    }

    if (tl.getInput('ignoreOrganizations', false)) {
      tl.setResult(tl.TaskResult.Failed, "Does not support ignoreOrganizations option");
      return;
    }

    // Configure the credential provider for both same-organization feeds and service connections
    const urls = (tl.getInput('externalFeeds', false) || '').split(',');
    const serviceConnections: ServiceConnection[] = [];
    if (urls.length > 0) {
      const extnAuth = tl.getInputRequired('externalAuthToken');
      for (const url of urls) {
        serviceConnections.push(new TokenServiceConnection(
          {
            uri: url
          },
          extnAuth,
          undefined
        ));
      }
    }

    await configureCredProvider(ProtocolType.NuGet, serviceConnections);
  } catch (error: any) {
    tl.setResult(tl.TaskResult.Failed, error.toString());
  } finally {
    emitTelemetry('Packaging', 'NuGetAuthenticateV1', {
      'NuGetAuthenticate.ForceReinstallCredentialProvider': forceReinstallCredentialProvider
    });
  }
}

main();
