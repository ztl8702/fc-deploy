/* eslint-disable no-await-in-loop */
import * as core from '@serverless-devs/core';
import { FcService, ServiceConfig } from './lib/fc/service';
import { FcFunction, FunctionConfig } from './lib/fc/function';
import { FcTrigger, TriggerConfig } from './lib/fc/trigger';
import { FcCustomDomain, CustomDomainConfig } from './lib/fc/custom-domain';
import { FcBaseComponent } from './lib/component/fc-base';
import { FcDomainComponent } from './lib/component/fc-domain';
import { FcBaseSdkComponent } from './lib/component/fc-base-sdk';
import {
  DEPLOY_SUPPORT_COMMAND,
  SUPPORTED_REMOVE_ARGS,
  COMPONENT_HELP_INFO,
  DEPLOY_HELP_INFO,
  REMOVE_HELP_INFO,
  DEPLOY_SUPPORT_CONFIG_ARGS,
} from './lib/static';
import * as _ from 'lodash';
import { mark, ServerlessProfile, replaceProjectName, ICredentials } from './lib/profile';
import { IProperties, IInputs } from './interface';
import * as path from 'path';
import { formatArgs, hasHttpPrefix } from './lib/utils/utils';
import { promiseRetry, retryDeployUntilSlsCreated } from './lib/retry';
import { isSlsNotExistException } from './lib/error';
import StdoutFormatter from './lib/component/stdout-formatter';
import { isAutoConfig } from './lib/definition';
import { VpcConfig } from './lib/resource/vpc';
import { AlicloudNas, NasConfig } from './lib/resource/nas';

export default class FcDeployComponent {
  @core.HLogger('FC-DEPLOY') logger: core.ILogger;
  private serverlessProfile: ServerlessProfile;
  private fcService: FcService;
  private fcFunction: FcFunction;
  private fcTriggers: FcTrigger[];
  private fcCustomDomains: FcCustomDomain[];
  private region: string;
  private credentials: ICredentials;
  private curPath: string;
  private args: string;
  private access: string;

  async deploy(inputs: IInputs): Promise<any> {
    const {
      isHelp,
    } = await this.handlerInputs(_.cloneDeep(inputs));
    if (isHelp) {
      core.help(DEPLOY_HELP_INFO);
      return;
    }
    const parsedArgs: {[key: string]: any} = core.commandParse(inputs, {
      boolean: ['help', 'assume-yes', 'use-local', 'escape-nas-check'],
      string: ['type'],
      alias: { help: 'h', 'assume-yes': 'y' } });
    const argsData: any = parsedArgs?.data || {};

    const assumeYes: boolean = argsData.y || argsData.assumeYes || argsData['assume-yes'];
    const useLocal: boolean = argsData['use-local'];
    // 指定 --escape-nas-check 参数后，当用户使用自定义的 nasConfig，不会进行 nasDir 的检查
    const escapeNasCheck: boolean = argsData['escape-nas-check'];
    let { type } = argsData;
    if (type && !DEPLOY_SUPPORT_CONFIG_ARGS.includes(type)) {
      core.help(DEPLOY_HELP_INFO);
      throw new Error(`Type does not support ${type}, only config and code are supported`);
    }
    const nonOptionsArgs = parsedArgs.data?._ || [];
    if (nonOptionsArgs.length > 1) {
      this.logger.error('Command error: expects argument.');
      return core.help(DEPLOY_HELP_INFO);
    }
    const command = nonOptionsArgs[0];
    if (command && !DEPLOY_SUPPORT_COMMAND.includes(command)) {
      this.logger.error(`Deploy ${command} is not supported now.`);
      return core.help(DEPLOY_HELP_INFO);
    }
    if (['service', 'trigger'].includes(command) && type) {
      // deploy service/trigger 不支持 --type 参数
      this.logger.warn(`Deploy ${command} dose not support --type option.\nFc will continue to deploy ${command} without --type option`);
      this.args = this.args.replace(`--type ${type}`, '');
      type = null;
    }
    const { fcBaseComponentIns, componentName, BaseComponent } = await this.handlerBase();
    if (type && (componentName === 'fc-base')) {
      // pulumi 底座时, --type 不生效
      this.logger.warn('Deployment in pulumi mode dose not support --type option. You can run [s cli fc-default set deploy-type sdk] to switch to sdk mode that supports --type option.\nFc will continue to deploy without --type option');
      if (this.args) {
        this.args = this.args.replace(`--type ${type}`, '');
      }
      type = null;
    }
    this.args = formatArgs(this.args);
    let targetTriggerNameArr: string[];
    if (command === 'trigger') {
      const targetTriggerName = argsData['trigger-name'];
      targetTriggerNameArr = typeof (targetTriggerName) === 'string' ? [targetTriggerName] : targetTriggerName;
    }
    const needDeployAll = (command === 'all');

    // service
    let resolvedServiceConf: ServiceConfig = this.fcService?.localConfig;
    let needDeployService = (needDeployAll && type !== 'code') || ((!command && type !== 'code') || command === 'service');
    if (needDeployService) {
      await this.fcService.init(useLocal);
      if (this.fcService.useRemote) {
        this.logger.info(`Service ${this.fcService.name} using online config, skip it.`);
        needDeployService = false;
      } else {
        resolvedServiceConf = await this.fcService.makeService(assumeYes, escapeNasCheck);
        resolvedServiceConf.name = resolvedServiceConf.name || resolvedServiceConf.serviceName;
      }
    }
    this.logger.debug(`Resolved serviceConf is:\n${JSON.stringify(resolvedServiceConf, null, '  ')}`);
    // function
    let resolvedFunctionConf: FunctionConfig = this.fcFunction?.localConfig;
    let needDeployFunction = needDeployAll || (!command || command === 'function');
    if (!_.isNil(this.fcFunction) && needDeployFunction) {
      const pushRegistry = parsedArgs.data ? parsedArgs.data['push-registry'] : undefined;
      if (pushRegistry) {
        this.logger.warn(StdoutFormatter.stdoutFormatter.warn('--push-registry', 'will be deprecated soon.'));
      }
      await this.fcFunction.init(type, useLocal, assumeYes);
      if (this.fcFunction.useRemote) {
        this.logger.info(`Function ${this.fcFunction.name} using online config, skip it.`);
        needDeployFunction = false;
      } else {
        const baseDir = path.dirname(this.curPath);

        resolvedFunctionConf = await this.fcFunction.makeFunction(baseDir, type, pushRegistry, assumeYes);
        resolvedFunctionConf.name = resolvedFunctionConf.name || resolvedFunctionConf.functionName;
        resolvedFunctionConf.serviceName = resolvedFunctionConf.serviceName || resolvedServiceConf.name;
        this.logger.debug(`Resolved functionConf is:\n${JSON.stringify(resolvedFunctionConf, null, '  ')}`);
      }
    }
    // triggers
    const resolvedTriggerConfs: TriggerConfig[] = [];
    let hasAutoTriggerRole = false;
    let needDeployTrigger = (needDeployAll && type !== 'code') || ((!command && type !== 'code') || command === 'trigger');
    let needDeployAllTriggers = true;
    if (!_.isEmpty(this.fcTriggers) && needDeployTrigger) {
      let existTriggersUseLocal = false;
      for (let i = 0; i < this.fcTriggers.length; i++) {
        if (!_.isEmpty(targetTriggerNameArr) && targetTriggerNameArr.includes(this.fcTriggers[i].name)) {
          continue;
        }
        await this.fcTriggers[i].init(useLocal);
        if (this.fcTriggers[i].useRemote) {
          this.logger.info(`Trigger ${this.fcTriggers[i].name} using online config, skip it.`);
          needDeployAllTriggers = false;
          continue;
        }
        existTriggersUseLocal = true;
        const resolvedTriggerConf: TriggerConfig = await this.fcTriggers[i].makeTrigger();
        resolvedTriggerConf.name = resolvedTriggerConf.name || resolvedTriggerConf.triggerName;
        resolvedTriggerConf.serviceName = resolvedTriggerConf.serviceName || resolvedServiceConf?.name;
        resolvedTriggerConf.functionName = resolvedTriggerConf.functionName || resolvedFunctionConf?.name;
        hasAutoTriggerRole = hasAutoTriggerRole || this.fcTriggers[i].isRoleAuto;
        resolvedTriggerConfs.push(resolvedTriggerConf);
        this.logger.debug(`Resolved trigger: \n${JSON.stringify(resolvedTriggerConf, null, '  ')}`);
      }
      needDeployTrigger = existTriggersUseLocal;
    }

    const profileOfFcBase = replaceProjectName(this.serverlessProfile, `${this.serverlessProfile?.project.projectName}-fc-base-project`);
    const fcBaseComponent = new BaseComponent(profileOfFcBase, resolvedServiceConf, this.region, this.credentials, this.curPath, resolvedFunctionConf, resolvedTriggerConfs);

    if (needDeployTrigger && needDeployFunction && needDeployService) {
      // 部署所有资源，则复用传入的 args 执行子组件的 deploy 方法
      const fcBaseComponentInputs = fcBaseComponent.genComponentInputs(componentName, this.args);

      await this.deployWithRetry(fcBaseComponentIns, fcBaseComponentInputs);
    } else {
      // 部署部分资源
      if (needDeployService) {
        this.logger.info(StdoutFormatter.stdoutFormatter.create('service', resolvedServiceConf.name));
        let resolvedArgs: string;
        if (command === 'service') {
          // deploy service
          resolvedArgs = this.args;
        } else {
          // deploy all 或 deploy
          resolvedArgs = command === 'all' ? this.args.replace(/all/g, 'service') : `service ${this.args}`;
        }
        const fcBaseComponentInputs = fcBaseComponent.genComponentInputs(componentName, formatArgs(resolvedArgs));
        await this.deployWithRetry(fcBaseComponentIns, fcBaseComponentInputs);
      }
      if (needDeployFunction) {
        this.logger.info(StdoutFormatter.stdoutFormatter.create('function', resolvedFunctionConf.name));
        let resolvedArgs: string;
        if (command === 'function') {
          // deploy function
          resolvedArgs = this.args;
        } else {
          // deploy all 或 deploy
          resolvedArgs = command === 'all' ? this.args.replace(/all/g, 'function') : `function ${this.args}`;
        }
        const fcBaseComponentInputs = fcBaseComponent.genComponentInputs(componentName, formatArgs(resolvedArgs));
        await this.deployWithRetry(fcBaseComponentIns, fcBaseComponentInputs);
      }

      if (needDeployTrigger) {
        if (_.isEmpty(resolvedTriggerConfs) && command === 'trigger') {
          this.logger.info('No trigger need to be deloyed.');
        } else if (!_.isEmpty(resolvedTriggerConfs)) {
          this.logger.info(StdoutFormatter.stdoutFormatter.create('triggers', JSON.stringify(resolvedTriggerConfs.map((t) => t.name))));
          let resolvedArgs: string;
          if (command === 'trigger') {
            // deploy function
            resolvedArgs = this.args;
          } else {
            // deploy all 或 deploy
            const triggerNamesInArgs: string = needDeployAllTriggers ? '' : resolvedTriggerConfs.map((triggerConf) => `--trigger-name ${triggerConf.name}`).join(' ');
            resolvedArgs = command === 'all' ? this.args.replace(/all/g, 'trigger') : `trigger ${this.args}`;
            resolvedArgs = triggerNamesInArgs ? resolvedArgs : (`${resolvedArgs } ${ triggerNamesInArgs}`);
          }
          const fcBaseComponentInputs = fcBaseComponent.genComponentInputs(componentName, formatArgs(resolvedArgs));
          await this.deployWithRetry(fcBaseComponentIns, fcBaseComponentInputs);
        }
      }
    }
    // set stateful config
    if (needDeployService && this.fcService) {
      const { remoteConfig } = await this.fcService.GetRemoteInfo('service', this.fcService.name, undefined, undefined);
      this.fcService.statefulConfig = remoteConfig;
      this.fcService.upgradeStatefulConfig();
    }
    if (needDeployFunction && this.fcFunction) {
      const { remoteConfig } = await this.fcFunction.GetRemoteInfo('function', this.fcFunction.serviceName, this.fcFunction.name, undefined);
      this.fcFunction.statefulConfig = remoteConfig;
      this.fcFunction.upgradeStatefulConfig();
    }
    // triggers
    if (needDeployTrigger && !_.isEmpty(this.fcTriggers)) {
      for (let i = 0; i < this.fcTriggers.length; i++) {
        if (!_.isEmpty(targetTriggerNameArr) && targetTriggerNameArr.includes(this.fcTriggers[i].name)) {
          continue;
        }
        const { remoteConfig } = await this.fcTriggers[i].GetRemoteInfo('trigger', this.fcTriggers[i].serviceName, this.fcTriggers[i].functionName, this.fcTriggers[i].name);
        this.fcTriggers[i].statefulConfig = remoteConfig;
        this.fcTriggers[i].upgradeStatefulConfig();
      }
    }

    await this.setStatefulConfig();

    // deploy custom domain
    let hasAutoCustomDomainNameInDomains = false;
    const resolvedCustomDomainConfs: CustomDomainConfig[] = [];
    const needDeployDomain = needDeployAll || ((!command && type !== 'code') || command === 'domain');
    if (!_.isEmpty(this.fcCustomDomains) && needDeployDomain) {
      for (let i = 0; i < this.fcCustomDomains.length; i++) {
        await this.fcCustomDomains[i].initLocal();
        const resolvedCustomDomainConf: CustomDomainConfig = await this.fcCustomDomains[i].makeCustomDomain(this.args);
        hasAutoCustomDomainNameInDomains = hasAutoCustomDomainNameInDomains || this.fcCustomDomains[i].isDomainNameAuto;
        resolvedCustomDomainConfs.push(resolvedCustomDomainConf);
        this.logger.debug(`resolved custom domain: \n${JSON.stringify(resolvedCustomDomainConf, null, '  ')}`);
      }
    }
    if (!_.isEmpty(resolvedCustomDomainConfs)) {
      const profileOfFcDomain = replaceProjectName(this.serverlessProfile, `${this.serverlessProfile?.project.projectName}-fc-domain-project`);
      for (const resolvedCustomDomainConf of resolvedCustomDomainConfs) {
        this.logger.info(StdoutFormatter.stdoutFormatter.create('custom domain', resolvedCustomDomainConf.domainName));

        const fcDomainComponent = new FcDomainComponent(profileOfFcDomain, resolvedCustomDomainConf, this.region, this.credentials, this.curPath);
        const fcDomainComponentInputs = fcDomainComponent.genComponentInputs('fc-domain', this.args);
        const fcDoaminComponentIns = await core.load('devsapp/fc-domain');
        await fcDoaminComponentIns.deploy(fcDomainComponentInputs);
      }
    }
    // remove zipped code
    if (!_.isEmpty(resolvedFunctionConf) && needDeployFunction) { await this.fcFunction.removeZipCode(resolvedFunctionConf?.codeUri); }

    if (hasAutoCustomDomainNameInDomains) {
      for (let i = 0; i < this.fcCustomDomains.length; i++) {
        await this.fcCustomDomains[i].setStatedCustomDomainConf(resolvedCustomDomainConfs[i]);
      }
    }
    const res = {
      region: this.region,
    };
    if (needDeployService) {
      Object.assign(res, { service: resolvedServiceConf });
    }
    const returnedFunctionConf: FunctionConfig = _.cloneDeep(resolvedFunctionConf);
    if (!_.isEmpty(resolvedFunctionConf?.codeUri)) {
      returnedFunctionConf.codeUri = this.fcFunction.useRemote ? this.fcFunction.remoteConfig?.codeUri : this.fcFunction.localConfig?.codeUri;
    }
    // const returnedFunctionConf = Object.assign({}, resolvedFunctionConf, {  });
    if (!_.isEmpty(resolvedFunctionConf) && needDeployFunction) {
      delete returnedFunctionConf.import;
      delete returnedFunctionConf.protect;
      Object.assign(res, { function: returnedFunctionConf });
    }
    if (!_.isEmpty(resolvedTriggerConfs) && needDeployTrigger) {
      for (const fcTrigger of this.fcTriggers) {
        // 只能同时部署一个 http trigger
        if (fcTrigger.isHttpTrigger()) {
          Object.assign(res, { systemDomain: fcTrigger.generateSystemDomain() });
        }
      }
      Object.assign(res, { triggers: resolvedTriggerConfs.map((t) => {
        delete t.import;
        delete t.protect;
        return t;
      }) });
    }
    if (!_.isEmpty(resolvedCustomDomainConfs) && needDeployDomain) {
      for (let i = 0; i < resolvedCustomDomainConfs.length; i++) {
        if (!hasHttpPrefix(resolvedCustomDomainConfs[i].domainName)) {
          resolvedCustomDomainConfs[i].domainName = `http://${resolvedCustomDomainConfs[i].domainName}`;
        }
      }
      Object.assign(res, { customDomains: resolvedCustomDomainConfs });
    }
    if (this.fcService.hasAutoConfig || hasAutoTriggerRole) {
      if (this.fcService.hasAutoConfig) {
        this.logger.log(`\nThere is auto config in the service: ${this.fcService?.name}`, 'yellow');
      } else {
        this.logger.log('\nThere is generated role config in the triggers config', 'yellow');
      }
    }

    return res;
  }

  async help(): Promise<void> {
    core.reportComponent('fc-deploy', {
      command: 'help',
      uid: null,
    });
    core.help(COMPONENT_HELP_INFO);
  }

  async remove(inputs: IInputs): Promise<any> {
    const {
      isHelp,
    } = await this.handlerInputs(_.cloneDeep(inputs));
    if (isHelp) {
      core.help(REMOVE_HELP_INFO);
      return;
    }
    const parsedArgs: {[key: string]: any} = core.commandParse(inputs, {
      boolean: ['help', 'assume-yes', 'use-local'],
      alias: { help: 'h', 'assume-yes': 'y' } });

    // 处理命令行参数
    const nonOptionsArgs = parsedArgs.data?._ || [];

    if (nonOptionsArgs.length > 1) {
      this.logger.error(` Error: unexpected argument: ${nonOptionsArgs[1]}`);
      // help info
      core.help(REMOVE_HELP_INFO);
      return;
    }
    const nonOptionsArg = nonOptionsArgs[0] || 'service';
    if (!SUPPORTED_REMOVE_ARGS.includes(nonOptionsArg)) {
      this.logger.error(` Remove ${nonOptionsArg} is not supported now.`);
      // help info
      core.help(REMOVE_HELP_INFO);
      return;
    }

    if (nonOptionsArg !== 'domain') {
      if (['service', 'all'].includes(nonOptionsArg)) { await this.fcService.initRemote('service', this.fcService.name); }
      if (['service', 'function', 'all'].includes(nonOptionsArg) && !_.isEmpty(this.fcFunction)) {
        await this.fcFunction.initRemote('function', this.fcFunction.serviceName, this.fcFunction.name);
      }
      const argsData: any = parsedArgs?.data || {};

      let targetTriggerNameArr: string[];
      if (nonOptionsArg === 'trigger') {
        const targetTriggerName = argsData['trigger-name'];
        targetTriggerNameArr = typeof (targetTriggerName) === 'string' ? [targetTriggerName] : targetTriggerName;
      }
      if (!_.isEmpty(this.fcTriggers)) {
        for (const fcTrigger of this.fcTriggers) {
          if (_.isEmpty(targetTriggerNameArr) || targetTriggerNameArr.includes(fcTrigger.name)) {
            await fcTrigger.initRemote('trigger', fcTrigger.serviceName, fcTrigger.functionName, fcTrigger.name);
          }
        }
      }

      const profileOfFcBase = replaceProjectName(this.serverlessProfile, `${this.serverlessProfile?.project.projectName}-fc-base-project`);
      const { fcBaseComponentIns, BaseComponent, componentName } = await this.handlerBase();
      await this.checkIfResourceExistOnline(nonOptionsArg, targetTriggerNameArr);

      const fcBaseComponent = new BaseComponent(profileOfFcBase, this.fcService.localConfig, this.region, this.credentials, this.curPath, this.fcFunction?.localConfig, this.fcTriggers.filter((t) => (t?.localConfig)).map((t) => (t?.localConfig)));
      const fcBaseComponentInputs = fcBaseComponent.genComponentInputs(componentName, this.args);

      const removeRes = await fcBaseComponentIns.remove(fcBaseComponentInputs);
      // unset state
      if (!_.isEmpty(this.fcTriggers)) {
        for (let i = 0; i < this.fcTriggers.length; i++) {
          if (_.isNil(targetTriggerNameArr) || targetTriggerNameArr.includes(this.fcTriggers[i].name)) {
            await this.fcTriggers[i].unsetState();
          }
        }
      }
      if (nonOptionsArg !== 'trigger') {
        // remove service or function
        if (!_.isEmpty(this.fcFunction)) { await this.fcFunction.unsetState(); }
      }
      if (nonOptionsArg === 'service') {
        if (!_.isEmpty(this.fcService)) { await this.fcService.unsetState(); }
      }

      // 尝试删除辅助函数
      try {
        const alicloudNas = new AlicloudNas(this.serverlessProfile, this.credentials, this.region, this.curPath);
        await alicloudNas.removeHelperService(this.fcService.name);
      } catch (e) {
        this.logger.debug(e);
      }

      return removeRes;
    }
    // remove domain
    if (_.isEmpty(this.fcCustomDomains)) { throw new Error('Please add custom domain config in s.yml/yaml'); }
    const profileOfFcDomain = replaceProjectName(this.serverlessProfile, `${this.serverlessProfile?.project.projectName}-fc-domain-project`);
    const removedCustomDomains: string[] = [];
    for (const fcCustomDomain of this.fcCustomDomains) {
      const resolvedCustomDomainConf: CustomDomainConfig = await fcCustomDomain.makeCustomDomain(this.args);
      this.logger.debug(`waiting for custom domain: ${resolvedCustomDomainConf.domainName} to be removed.`);
      const fcDomainComponent = new FcDomainComponent(profileOfFcDomain, resolvedCustomDomainConf, this.region, this.credentials, this.curPath);
      const fcDomainComponentInputs = fcDomainComponent.genComponentInputs('fc-domain', this.args);
      const fcDoaminComponentIns = await core.load('devsapp/fc-domain');
      await fcDoaminComponentIns.remove(fcDomainComponentInputs);
      removedCustomDomains.push(resolvedCustomDomainConf.domainName);
      await fcCustomDomain.delStatedCustomDomainConf();
    }
    return `Remove custom domain: ${removedCustomDomains.map((t) => t)}`;
  }

  async deployAutoNas(inputs: IInputs): Promise<any> {
    const {
      isHelp,
    } = await this.handlerInputs(_.cloneDeep(inputs));
    if (isHelp) {
      this.logger.info('There is no help info for deployAutoNas method.');
      return;
    }
    if (!isAutoConfig(this.fcService.localConfig?.nasConfig)) {
      this.logger.error('Method deployAutoNas only supports auto nasConfig.');
      return;
    }
    await this.fcService.initStatefulAutoConfig();
    await this.fcService.initLocal();
    if (!isAutoConfig(this.fcService.localConfig?.nasConfig)) {
      this.logger.info('You have created auto nas config before.');
      return this.fcService.localConfig.nasConfig;
    }
    const parsedArgs: {[key: string]: any} = core.commandParse(inputs, {
      boolean: ['help', 'assume-yes'],
      alias: { help: 'h', 'assume-yes': 'y' } });
    const argsData: any = parsedArgs?.data || {};

    const assumeYes: boolean = argsData.y || argsData.assumeYes || argsData['assume-yes'];
    const role: string = await this.fcService.generateServiceRole();
    const vpcConfig: VpcConfig = await this.fcService.generateServiceVpc(true);
    const nasConfig: NasConfig = await this.fcService.generateServiceNas(vpcConfig, role, assumeYes);
    const nasConfigInRemoteFormat: any = {
      userId: nasConfig.userId,
      groupId: nasConfig.groupId,
      mountPoints: nasConfig.mountPoints.map((item) => AlicloudNas.transformMountpointFromLocalToRemote({ serverAddr: item.serverAddr, nasDir: item.nasDir, fcDir: item.fcDir })),
    };
    this.fcService.statefulConfig = {};
    Object.assign(this.fcService.statefulConfig, {
      nasConfig: nasConfigInRemoteFormat,
      vpcConfig,
      role,
    });
    await this.fcService.setStatefulAutoConfig();
    return nasConfig;
  }

  async report(componentName: string, command: string, accountID?: string, access?: string): Promise<void> {
    let uid: string = accountID;
    if (!accountID && !access) {
      const credentials: ICredentials = await core.getCredential(access);
      uid = credentials.AccountID;
    }
    core.reportComponent(componentName, {
      command,
      uid,
    }).catch((e) => {
      this.logger.warn(StdoutFormatter.stdoutFormatter.warn('component report', `component name: ${componentName}, method: ${command}`, e.message));
    });
  }

  private async handlerBase() {
    const fcDefault = await core.loadComponent('devsapp/fc-default');
    const res = await fcDefault.get({ args: 'deploy-type' });
    if (res === 'pulumi') {
      return {
        fcBaseComponentIns: await core.loadComponent('devsapp/fc-base'),
        BaseComponent: FcBaseComponent,
        componentName: 'fc-base',
      };
    }

    return {
      fcBaseComponentIns: await core.loadComponent('devsapp/fc-base-sdk'),
      BaseComponent: FcBaseSdkComponent,
      componentName: 'fc-base-sdk',
    };
  }

  private async setStatefulConfig(): Promise<void> {
    if (this.fcService) {
      await this.fcService.setStatefulConfig();
      await this.fcService.setStatefulAutoConfig();
    }
    if (this.fcFunction) { await this.fcFunction.setStatefulConfig(); }
    if (!_.isEmpty(this.fcTriggers)) {
      for (const fcTrigger of this.fcTriggers) {
        await fcTrigger.setStatefulConfig();
      }
    }
  }

  private async checkIfResourceExistOnline(resourceType: string, resourceName?: any): Promise<boolean> {
    if (resourceType === 'service' && _.isEmpty(this.fcService?.remoteConfig)) {
      this.logger.error(`Service ${this.fcService?.name} dose not exist online.`);
      return false;
    }
    if (resourceType === 'function' && _.isEmpty(this.fcFunction?.remoteConfig)) {
      this.logger.error(`Function ${this.fcFunction?.name} dose not exist online.`);
      return false;
    }
    if (resourceType === 'trigger' && resourceName) {
      for (const fcTrigger of this.fcTriggers) {
        if (resourceName.includes(fcTrigger?.name) && _.isEmpty(fcTrigger?.remoteConfig)) {
          this.logger.error(`Trigger ${resourceName} dose not exist online.`);
          return false;
        }
      }
    } else if (resourceType === 'trigger' && !resourceName) {
      let triggersExistOnline = false;
      for (const fcTrigger of this.fcTriggers) {
        if (_.isEmpty(fcTrigger?.remoteConfig)) {
          this.logger.error(`Trigger ${resourceName} dose not exist online.`);
        } else {
          triggersExistOnline = true;
        }
      }
      return triggersExistOnline;
    }
    return true;
  }

  // 解析入参
  private async handlerInputs(inputs: IInputs): Promise<{[key: string]: any}> {
    await StdoutFormatter.initStdout();
    const project = inputs?.project;
    this.access = project?.access;
    this.credentials = await core.getCredential(this.access);
    await this.report('fc-deploy', inputs?.command, this.credentials.AccountID, inputs?.project?.access);

    const properties: IProperties = inputs?.props;

    const appName: string = inputs?.appName;
    this.args = formatArgs(inputs?.args);

    this.curPath = inputs?.path?.configPath;
    const projectName: string = project?.projectName;
    const parsedArgs: {[key: string]: any} = core.commandParse(inputs, {
      boolean: ['help'],
      alias: { help: 'h' } });
    const argsData: any = parsedArgs?.data || {};
    if (argsData?.help) {
      return {
        isHelp: true,
      };
    }

    this.region = argsData?.region || properties?.region;
    this.logger.info(StdoutFormatter.stdoutFormatter.using('region', this.region));
    this.logger.info(StdoutFormatter.stdoutFormatter.using('access alias', this.access));
    this.logger.info(StdoutFormatter.stdoutFormatter.using('accessKeyID', mark(String(this.credentials.AccessKeyID))));
    this.logger.info(StdoutFormatter.stdoutFormatter.using('accessKeySecret', mark(String(this.credentials.AccessKeySecret))));

    this.serverlessProfile = {
      project: {
        access: this.access,
        projectName,
      },
      appName,
    };

    // @ts-ignore
    const serviceConf: ServiceConfig = properties?.service || {};
    if (!_.isNil(argsData['service-name'])) {
      serviceConf.name = argsData['service-name'];
    }
    // @ts-ignore
    const functionConf: FunctionConfig = properties?.function || {};
    if (!_.isNil(argsData['function-name'])) {
      functionConf.name = argsData['function-name'];
    }
    const triggerConfs: TriggerConfig[] = properties?.triggers;
    const customDomainConfs: CustomDomainConfig[] = properties?.customDomains || [];
    // cli 支持 domain --domain-name <domainName>
    if (parsedArgs?.data?._?.[0] === 'domain' && _.isEmpty(customDomainConfs) && !_.isNil(argsData['domain-name'])) {
      // 模拟一个真实的配置，绕过一系列的校验后面
      customDomainConfs.push({
        domainName: argsData['domain-name'],
        protocol: argsData.protocol || 'HTTP',
        routeConfigs: [{ path: '/*' }],
      });
    }

    this.fcTriggers = [];
    this.fcCustomDomains = [];

    this.logger.debug(`instantiate serviceConfig with : \n${JSON.stringify(serviceConf, null, '  ')}`);
    this.fcService = new FcService(serviceConf, functionConf, this.serverlessProfile, this.region, this.credentials, this.curPath);
    if (!_.isEmpty(functionConf)) {
      this.logger.debug(`functionConfig not empty: \n${JSON.stringify(functionConf, null, '  ')}, instantiate it.`);
      this.fcFunction = new FcFunction(functionConf, serviceConf?.name, this.serverlessProfile, this.region, this.credentials, this.curPath);
    }

    if (!_.isEmpty(triggerConfs)) {
      this.logger.debug(`triggersConfig not empty: \n${JSON.stringify(triggerConfs, null, '  ')}, instantiate them.`);
      for (const triggerConf of triggerConfs) {
        const fcTrigger = new FcTrigger(triggerConf, serviceConf?.name, functionConf?.name, this.serverlessProfile, this.region, this.credentials, this.curPath);
        this.fcTriggers.push(fcTrigger);
      }
    }

    if (!_.isEmpty(customDomainConfs)) {
      this.logger.debug(`customDomains not empty: \n${JSON.stringify(customDomainConfs, null, '  ')}, instantiate them.`);
      for (const customDomainConf of customDomainConfs) {
        const fcCustomDomain = new FcCustomDomain(customDomainConf, serviceConf?.name, functionConf?.name, triggerConfs, this.serverlessProfile, this.region, this.credentials, this.curPath);
        this.fcCustomDomains.push(fcCustomDomain);
      }
    }
    return {
      isHelp: false,
    };
  }

  // 调用 fc-base/fc-base-sdk 组件部署资源
  private async deployWithRetry(fcBaseComponentIns, fcBaseComponentInputs): Promise<any> {
    // logConfig 配置是auto时重试部署 40 次,否则按照正常的逻辑重试
    const logConfigIsAuto = isAutoConfig(this.fcService?.localConfig?.logConfig);
    await promiseRetry(async (retry: any, times: number): Promise<any> => {
      try {
        if (logConfigIsAuto) {
          await retryDeployUntilSlsCreated(fcBaseComponentIns, fcBaseComponentInputs);
        } else {
          await fcBaseComponentIns.deploy(fcBaseComponentInputs);
        }
        return;
      } catch (ex) {
        if (ex.code === 'AccessDenied' || (logConfigIsAuto && isSlsNotExistException(ex))) {
          throw ex;
        }
        this.logger.debug(`error when create service/function/trigger or update service/function/trigger, error is: \n${ex}`);
        this.logger.info(StdoutFormatter.stdoutFormatter.retry('fc', 'create', '', times));
        retry(ex);
      }
    });
  }
}
