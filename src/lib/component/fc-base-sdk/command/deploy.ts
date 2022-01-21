/* eslint-disable no-await-in-loop */
/* eslint-disable require-atomic-updates */
import _ from 'lodash';
import fs from 'fs';
import Client from '../../../utils/client';
import {
  getTargetTriggers,
  transfromTriggerConfig,
  objectDeepTransfromString,
} from '../../../utils/utils';
import { IProperties } from '../../../../common/entity';
import { isCode, isCustomContainerConfig } from '../../../../interface/function';
import { makeDestination } from './function-async-config';
import logger from '../../../../common/logger';

export default class Component {
  /**
   * 部署资源
   * @param props
   * @param param1
   *  command: 执行的二级指令：service、function、trigger 或者为空，为空时部署所有
   *  type：部署的类型：all、config、code
   *  onlyDelpoyTriggerName：当 command 为 trigger 时生效，仅部署哪些触发器
   * @returns
   */
  static async deploy(props: IProperties, { command, type, onlyDelpoyTriggerName, logConfigIsAuto }: any): Promise<any> {
    const { region, service, function: functionConfig, triggers } = props;
    const deployAllConfig = !command && (type === 'all' || type === 'config');

    // 校验配置
    const commandIsFunction = command === 'function';
    if (commandIsFunction && _.isEmpty(functionConfig)) {
      throw new Error(
        'The deployment function was specified, but the function configuration was not found',
      );
    }
    const commandIsTirgger = command === 'trigger';
    if (commandIsTirgger && _.isEmpty(triggers)) {
      throw new Error(
        'The deployment trigger was specified, but the trigger configuration was not found',
      );
    }
    let deployTriggers = [];
    const needDeployTrigger = deployAllConfig || commandIsTirgger;
    if (needDeployTrigger && triggers) {
      if (commandIsTirgger && onlyDelpoyTriggerName) {
        deployTriggers = getTargetTriggers(triggers, onlyDelpoyTriggerName);
      } else {
        deployTriggers = triggers;
      }
    }

    const deployRes: any = {};
    const fcClient = await Client.fcClient();

    // 开始部署
    const needDeployService = deployAllConfig || command === 'service';
    const needDeployFunction = !command || commandIsFunction;

    if (logConfigIsAuto) {
      if (needDeployService) {
        deployRes.service = await this.makeService(fcClient, service);
      }
      if (needDeployFunction && Boolean(functionConfig)) {
        deployRes.function = await this.makeFunction(fcClient, functionConfig, type);
      }
      if (!_.isEmpty(deployTriggers)) {
        const triggersRes = [];
        for (const triggerConfig of deployTriggers) {
          const triggerRes = await this.makeTrigger(
            fcClient,
            triggerConfig.service,
            triggerConfig.function,
            transfromTriggerConfig(triggerConfig, region, Client.credentials.AccountID),
          );
          triggersRes.push(triggerRes);
        }
        deployRes.triggers = triggersRes;
      }
    } else {
      await logger.task('Creating', [
        {
          title: `Creating Service ${service?.name}...`,
          id: 'Service',
          enabled: () => needDeployService,
          task: async () => {
            deployRes.service = await this.makeService(fcClient, service);
          },
        },
        {
          title: `Creating Function ${functionConfig?.service}/${functionConfig?.name}...`,
          id: 'Function',
          enabled: () => needDeployFunction && Boolean(functionConfig),
          task: async () => {
            deployRes.function = await this.makeFunction(fcClient, functionConfig, type);
          },
        },
        {
          title: 'Creating Trigger...',
          id: 'Triggers',
          enabled: () => !_.isEmpty(deployTriggers),
          task: async () => {
            const triggersRes = [];
            for (const triggerConfig of deployTriggers) {
              const triggerRes = await this.makeTrigger(
                fcClient,
                triggerConfig.service,
                triggerConfig.function,
                transfromTriggerConfig(triggerConfig, region, Client.credentials.AccountID),
              );
              triggersRes.push(triggerRes);
            }
            deployRes.triggers = triggersRes;
          },
        },
      ]);
    }

    return deployRes;
  }

  static async makeService(fcClient, sourceServiceConfig) {
    const { name, vpcConfig, nasConfig, logConfig, role } = sourceServiceConfig;
    const serviceConfig = _.cloneDeep(sourceServiceConfig);

    if (!logConfig) {
      serviceConfig.logConfig = {
        project: '',
        logstore: '',
        logBeginRule: 'None',
        enableRequestMetrics: false,
        enableInstanceMetrics: false,
      };
    }

    if (!nasConfig) {
      serviceConfig.nasConfig = {
        mountPoints: [],
        userId: -1,
        groupId: -1,
      };
    }
    if (!vpcConfig) {
      serviceConfig.vpcConfig = {
        vswitchIds: [],
        securityGroupId: '',
        vpcId: '',
      };
    }

    if (_.isNil(role)) {
      serviceConfig.role = '';
    }

    if (serviceConfig.tracingConfig === 'Enable') {
      const xtraceClient = Client.xtraceClient();
      try {
        const { Token: token } = await xtraceClient.request('GetToken', {}, {});
        serviceConfig.tracingConfig = {
          type: 'Jaeger',
          params: {
            endpoint: `${token.InternalDomain}/adapt_${token.LicenseKey}_${token.Pid}/api/traces`,
          },
        };
      } catch (e) {
        if (e.code === '40301' && e.message?.includes('AliyunARMSFullAccess')) {
          e.message = '子账号没有访问权限,需要主账号进行授权 AliyunTracingAnalysisReadOnlyAccess';
        }
        throw e;
      }
    } else {
      serviceConfig.tracingConfig = {};
    }

    let res;
    try {
      res = await fcClient.createService(name, serviceConfig);
    } catch (ex) {
      if (ex.code !== 'ServiceAlreadyExists') {
        logger.debug(`ex code: ${ex.code}, ex: ${ex.message}`);
        throw ex;
      }
      res = await fcClient.updateService(name, serviceConfig);
    }

    return res;
  }

  static async makeFunction(fcClient, sourceFunctionConfig, type) {
    const functionConfig = _.cloneDeep(sourceFunctionConfig);
    const serviceName = functionConfig.service;
    const functionName = functionConfig.name;
    const onlyDeployConfig = type === 'config';
    const onlyDeployCode = type === 'code';

    const {
      filename,
      runtime,
      customContainerConfig,
      ossBucket,
      ossKey,
      asyncConfiguration,
      instanceLifecycleConfig,
      customDNS,
      layers,
      environmentVariables = {},
    } = sourceFunctionConfig;
    // 接口仅接受 string 类型，value值需要toString强制转换为字符串
    functionConfig.environmentVariables = _.mapValues(environmentVariables, (value) =>
      value?.toString());
    functionConfig.initializer = functionConfig.initializer || '';
    delete functionConfig.asyncConfiguration;

    if (!onlyDeployConfig) {
      if (filename) {
        if (fs.statSync(filename).size > 52428800) {
          functionConfig.withoutCodeLimit = true;
          functionConfig.code = {
            zipFile: filename,
          };
        } else {
          functionConfig.code = {
            zipFile: fs.readFileSync(filename, 'base64'),
          };
        }
      } else if (ossBucket && ossKey) {
        functionConfig.code = {
          ossBucketName: ossBucket,
          ossObjectName: ossKey,
        };
      }

      if (onlyDeployCode) {
        await fcClient.updateFunction(serviceName, functionName, { code: functionConfig.code });
        return;
      }
    }

    const emptyProp = {
      handler: '',
    };
    functionConfig.instanceLifecycleConfig = {
      preFreeze: instanceLifecycleConfig?.preFreeze || emptyProp,
      preStop: instanceLifecycleConfig?.preStop || emptyProp,
    };

    if (_.isEmpty(customDNS)) {
      functionConfig.customDNS = { nameServers: null, searches: null, dnsOptions: null };
    } else {
      // 接口仅接受 string 类型，value值需要toString强制转换为字符串
      functionConfig.customDNS = objectDeepTransfromString(customDNS);
    }

    // 如果自定义 endpoint，layers 配置不能兜底
    if (_.isEmpty(layers) && !(await Client.getFcEndpoint())) {
      functionConfig.layers = [];
    }

    if (runtime === 'custom-container') {
      if (!isCustomContainerConfig(customContainerConfig)) {
        throw new Error(
          `${serviceName}/${functionName} runtime is custom-container, but customContainerConfig is not configured.`,
        );
      }
    } else if (!onlyDeployConfig && !isCode(functionConfig.code)) {
      throw new Error(`${serviceName}/${functionName} code is not configured.`);
    }

    let res;
    logger.debug(`handler function config: ${JSON.stringify(functionConfig, null, 2)}`);
    try {
      res = await fcClient.updateFunction(serviceName, functionName, functionConfig);
    } catch (ex) {
      if (ex.code !== 'FunctionNotFound' || onlyDeployConfig) {
        logger.debug(`ex code: ${ex.code}, ex: ${ex.message}`);
        throw ex;
      }
      functionConfig.functionName = functionName;
      res = await fcClient.createFunction(serviceName, functionConfig);
    }

    let asyncWarn = '';
    try {
      await makeDestination({
        serviceName,
        functionName,
        asyncConfiguration,
      });
    } catch (e) {
      if (_.isEmpty(asyncConfiguration) && e.message.includes('failed with 403')) {
        asyncWarn = e.message;
      } else {
        throw e;
      }
    }
    if (asyncWarn) {
      logger.warn(`Reminder function.asyncConfig: ${asyncWarn}`);
    }

    return res;
  }

  static async makeTrigger(fcClient, serviceName, functionName, triggerConfig) {
    const { triggerName } = triggerConfig;

    if (triggerConfig.qualifier) {
      // eslint-disable-next-line no-param-reassign
      triggerConfig.qualifier = triggerConfig.qualifier.toString();
    }

    let res;
    try {
      res = await fcClient.createTrigger(serviceName, functionName, triggerConfig);
    } catch (ex) {
      if (ex.code !== 'TriggerAlreadyExists') {
        logger.debug(`ex code: ${ex.code}, ex: ${ex.message}`);
        throw ex;
      }
      try {
        res = await fcClient.updateTrigger(serviceName, functionName, triggerName, triggerConfig);
      } catch (e) {
        if (e.message.includes('Updating trigger is not supported yet.')) {
          logger.debug(
            `Updating ${serviceName}/${functionName}/${triggerName} is not supported yet.`,
          );
          return triggerConfig;
        }
        throw e;
      }
    }

    return res;
  }
}
