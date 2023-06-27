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

    // Configure the credential provider for both same-organization feeds and service connections
    const urls = (tl.getInput('externalFeeds', false) || '').split(',');
    const serviceConnections: ServiceConnection[] = [];
    if (serviceConnections.length > 0) {
      const extnAuth = tl.getInputRequired('externalAuthToken');
      for (const url in urls) {
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
