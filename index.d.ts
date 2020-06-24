declare type FETCH_OPT = {
    json?: boolean;
    ignoreStatus?: boolean;
    data?: object;
};
export default function fetchUrl(url: string, options?: FETCH_OPT): Promise<any>;
export {};
