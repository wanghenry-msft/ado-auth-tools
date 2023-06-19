import fs = require('fs');
import path = require('path');
import tl = require('azure-pipelines-task-lib/task');

import { getSystemAccessToken } from 'azure-pipelines-tasks-artifacts-common/webapi';
import { getHandlerFromToken, WebApi } from 'azure-devops-node-api';
import { ITaskApi } from 'azure-devops-node-api/TaskApi';
import { IExecSyncResult } from 'azure-pipelines-task-lib/toolrunner';

function throwIfErr(res: IExecSyncResult, msg?: string) {
  if (res.code != 0) {
    tl.error(`Error code: [${res.code}]: ${msg || 'command failed'}`)
    throw res;
  }
}

abstract class AuthMethod {
  protected connectedService: string;

  constructor(connectedService: string) {
    this.connectedService = connectedService;
  }

  abstract fetchAuthToken(): Promise<string>;

  protected fetchAdoAuthTokenFromAzCli(): string {
    let res = tl.execSync('az', ['account', 'get-access-token', '--scope', '499b84ac-1321-427f-aa17-267ca6975798/.default'], {
      silent: true,
    });
    throwIfErr(res);
    return JSON.parse(res.stdout)['accessToken'];
  }

  getParameter(name: string): string {
    return tl.getEndpointAuthorizationParameter(this.connectedService, name, false)!;
  }

  cleanup() {}
}

class WIFAuthMethod extends AuthMethod {
  private servicePrincipalId: string;
  private tenantId: string;

  constructor(connectedService: string) {
    super(connectedService);
    this.servicePrincipalId = this.getParameter('serviceprincipalid');
    this.tenantId = this.getParameter('tenantid');
  }

  async fetchAuthToken(): Promise<string> {
    const federatedToken = await this.getIdToken();
    if (federatedToken === undefined) {
      throw 'Unable to get federated token';
    }

    const args: Array<string> = [
      'login', '--service-principal', '-u', this.servicePrincipalId,
      '--tenant', this.tenantId, '--allow-no-subscriptions',
      '--federated-token', federatedToken,
    ];
    throwIfErr(tl.execSync('az', args), 'failed to login to azcli');
    return this.fetchAdoAuthTokenFromAzCli();
  }

  private async getIdToken() : Promise<string|undefined> {
    const jobId = tl.getVariable('System.JobId');
    const planId = tl.getVariable('System.PlanId');
    const projectId = tl.getVariable('System.TeamProjectId');
    const hub = tl.getVariable('System.HostType');
    const uri = tl.getVariable('System.CollectionUri');
    const token = getSystemAccessToken();
    if (!jobId || !planId || !projectId || !hub || !uri) {
      return undefined;
    }

    const authHandler = getHandlerFromToken(token);
    const connection = new WebApi(uri, authHandler);
    const api: ITaskApi = await connection.getTaskApi();
    const response = await api.createOidcToken({}, projectId, hub, planId, jobId, this.connectedService);
    if (response == null) {
        return undefined;
    }

    let oidcToken = response.oidcToken;
    if (!!oidcToken) {
      tl.setSecret(oidcToken);
    }
    return oidcToken;
  }
}

class SPAuthMethod extends AuthMethod {
  private servicePrincipalId: string;
  private tenantId: string;
  private cliPassword: string;
  private authType: 'spncertificate' | 'spnkey';

  constructor(connectedService: string) {
    super(connectedService);
    this.servicePrincipalId = this.getParameter('serviceprincipalid');
    this.tenantId = this.getParameter('tenantid');
    const authType = this.getParameter('authenticationtype').toLowerCase();
    switch (authType) {
    case 'spncertificate':
      tl.debug('certificate based endpoint');
      const certContent = this.getParameter('servicePrincipalCertificate');
      this.cliPassword = path.join(tl.getVariable('Agent.TempDirectory') || tl.getVariable('system.DefaultWorkingDirectory')!, 'spnCert.pem');
      fs.writeFileSync(this.cliPassword, certContent);
      break;
    case 'spnkey':
      tl.debug('key based endpoint');
      this.cliPassword = this.getParameter('servicePrincipalKey');
      break;
    default:
      throw `Unsupported authType: ${authType}`;
    }

    this.authType = authType;

    tl.setSecret(this.cliPassword);

  }

  async fetchAuthToken(): Promise<string> {
    const args: Array<string> = [
      'login', '--service-principal', '-u', this.servicePrincipalId,
      '--tenant', this.tenantId, '--allow-no-subscriptions',
      '--password', this.cliPassword,
    ];
    throwIfErr(tl.execSync('az', args), 'failed to login to azcli');
    return this.fetchAdoAuthTokenFromAzCli();
  }

  cleanup(): void {
    if (this.authType == 'spncertificate') {
      tl.debug('Removing spn certificate file');
      tl.rmRF(this.cliPassword);
    }
  }
}

class MSIAuthMethod extends AuthMethod {
  constructor(connectedService: string) {
    super(connectedService);
  }

  async fetchAuthToken(): Promise<string> {
    throwIfErr(tl.execSync('az', ['login', '--identity']), 'failed to login to azcli via managed identity');
    return this.fetchAdoAuthTokenFromAzCli();
  }
}

const AUTH_METHODS: { [id: string]: (connectionService: string) => AuthMethod } = {
  'workloadidentityfederation': (a0) => new WIFAuthMethod(a0),
  'serviceprincipal': (a0) => new SPAuthMethod(a0),
  'managedserviceidentity': (a0) => new MSIAuthMethod(a0),
}

class Auth {
  private connectedService: string;
  private authMeth: AuthMethod;

  constructor(connectedService: string) {
    this.connectedService = connectedService;

    throwIfErr(tl.execSync("az", "--version"));
    this.setConfigDirectory();
    this.setAzureCloudBasedOnServiceEndpoint();

    const authScheme = tl.getEndpointAuthorizationScheme(this.connectedService, true);
    const authMethFactory = AUTH_METHODS[authScheme?.toLowerCase() || ''];
    if (!authMethFactory) {
      throw `Auth Scheme ${authScheme} is not supported`;
    }

    this.authMeth = authMethFactory(this.connectedService);
  }

  async updateToken(outputVar: string): Promise<void> {
    let token = await this.authMeth.fetchAuthToken();
    tl.setVariable(outputVar, token, true);
  }

  cleanup(): void {
    this.authMeth.cleanup();
  }

  private setAzureCloudBasedOnServiceEndpoint(): void {
    let env = tl.getEndpointAuthorizationParameter(this.connectedService, 'environment', true);
    if (!!env) {
      console.log(`Setting Azure cloud environment to: ${env}`);
      throwIfErr(tl.execSync('az', ['cloud', 'set', '-n', env]))
    }
  }

  private setConfigDirectory(): void {
    if (tl.getBoolInput('useGlobalConfig')) {
      return;
    }

    const tmpDir = tl.getVariable('Agent.TempDirectory')
    if (!!tmpDir) {
      const azCliConfigPath = path.join(tmpDir, '.azclitask');
      console.log(`Setting Azure config directory to: ${azCliConfigPath}`);
      process.env['AZURE_CONFIG_DIR'] = azCliConfigPath;
    }
  }
}

export class Task {
  public static async runMain(): Promise<void> {
    let toolExecutionError: Auth | undefined = undefined;
    let auth: Auth | undefined = undefined;
    let tokenOutputVariable: string | undefined = undefined;
    try {
      tokenOutputVariable = tl.getInputRequired('tokenOutputVariable');
      auth = new Auth(tl.getInputRequired('connectedServiceNameARM'));
      await auth.updateToken(tokenOutputVariable);
    } catch (err: any) {
      if (err.stderr) {
        toolExecutionError = err.stderr;
      } else {
        toolExecutionError = err;
      }
    } finally {
      if (!!auth) {
        auth.cleanup();
      }
    }

    if (!!toolExecutionError) {
      tl.setResult(tl.TaskResult.Failed, `Failed to authenticate: ${toolExecutionError}`)
    } else {
      tl.setResult(tl.TaskResult.Succeeded, `Fetched access token for ADO to ${tokenOutputVariable || ''}.`)
    }
  }
}

Task.runMain();
