export declare const FUNCTION_CONF_DEFAULT: {
    description: string;
    runtime: string;
    handler: string;
    memorySize: number;
    timeout: number;
    caPort: number;
    instanceConcurrency: number;
    instanceType: string;
    codeUri: string;
};
export declare const DEPLOY_SUPPORT_COMMAND: string[];
export declare const DEPLOY_SUPPORT_CONFIG_ARGS: string[];
export declare const SUPPORTED_REMOVE_ARGS: string[];
export declare const FC_DEPLOY_CACHE_DIR: string;
export declare const FC_CODE_CACHE_DIR: string;
export declare const FC_NAS_SERVICE_PREFIX = "_FC_NAS_";
export declare const DESCRIPTION = "generated by fc-deploy component";
export declare const FC_DEFAULT_ROLE = "AliyunFCDefaultRole";
export declare const FC_DEFAULT_ROLE_POLICY = "AliyunFCDefaultRolePolicy";
export declare const FC_DEFAULT_ROLE_POLICY_STATEMENT: {
    Action: string[];
    Resource: string;
    Effect: string;
}[];
export declare const COMPONENT_HELP_INFO: ({
    header: string;
    content: string;
} | {
    header: string;
    content: {
        name: string;
        summary: string;
    }[];
} | {
    header: string;
    content: string[];
})[];
export declare const DEPLOY_HELP_INFO: ({
    header: string;
    content: string;
    optionList?: undefined;
} | {
    header: string;
    optionList: ({
        name: string;
        description: string;
        type: BooleanConstructor;
        typeLabel?: undefined;
    } | {
        name: string;
        typeLabel: string;
        description: string;
        type?: undefined;
    })[];
    content?: undefined;
} | {
    header: string;
    optionList: {
        name: string;
        description: string;
        alias: string;
        type: BooleanConstructor;
    }[];
    content?: undefined;
} | {
    header: string;
    content: string[];
    optionList?: undefined;
})[];
export declare const REMOVE_HELP_INFO: ({
    header: string;
    content: string;
    optionList?: undefined;
} | {
    header: string;
    optionList: {
        name: string;
        description: string;
        type: StringConstructor;
    }[];
    content?: undefined;
} | {
    header: string;
    optionList: {
        name: string;
        typeLabel: string;
        description: string;
        alias: string;
        type: StringConstructor;
    }[];
    content?: undefined;
} | {
    header: string;
    optionList: {
        name: string;
        description: string;
        alias: string;
        type: BooleanConstructor;
    }[];
    content?: undefined;
} | {
    header: string;
    content: string[];
    optionList?: undefined;
})[];