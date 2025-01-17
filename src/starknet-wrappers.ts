import { Image, ProcessResult } from "@nomiclabs/hardhat-docker";
import axios from "axios";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import path from "path";
import { hash, number } from "starknet";
import { DockerCairo1Compiler, exec } from "./cairo1-compiler";
import {
    CAIRO1_COMPILE_BIN,
    CAIRO1_SIERRA_COMPILE_BIN,
    DOCKER_HOST_BIN_PATH,
    DOCKER_HOST,
    PLUGIN_NAME,
    StarknetChainId
} from "./constants";
import { ExternalServer } from "./external-server";
import { StarknetDockerProxy } from "./starknet-docker-proxy";
import { StarknetPluginError } from "./starknet-plugin-error";
import { FeeEstimation } from "./starknet-types";
import { StarknetVenvProxy } from "./starknet-venv-proxy";
import { BlockNumber, InteractChoice } from "./types";
import { getPrefixedCommand, normalizeVenvPath } from "./utils/venv";

interface CompileWrapperOptions {
    file: string;
    output: string;
    abi: string;
    cairoPath: string;
    accountContract: boolean;
    disableHintValidation: boolean;
}

interface CairoToSierraOptions {
    path: string;
    output: string;
    binDirPath?: string;
    replaceIds?: boolean;
    allowedLibfuncsListName?: string;
    allowedLibfuncsListFile?: string;
}

interface SierraToCasmOptions {
    file: string;
    output: string;
    binDirPath?: string;
    allowedLibfuncsListName?: string;
    allowedLibfuncsListFile?: string;
    addPythonicHints?: boolean;
}

interface DeclareWrapperOptions {
    contract: string;
    maxFee: string;
    signature?: string[];
    token?: string;
    sender?: string;
    nonce?: string;
}

interface InteractWrapperOptions {
    maxFee: string;
    nonce: string;
    choice: InteractChoice;
    address: string;
    abi?: string;
    functionName: string;
    inputs?: string[];
    signature?: string[];
    blockNumber?: BlockNumber;
}

interface TxHashQueryWrapperOptions {
    hash: string;
}

interface BlockQueryWrapperOptions {
    number?: BlockNumber;
    hash?: string;
}

interface NonceQueryWrapperOptions {
    address: string;
    blockHash?: string;
    blockNumber?: BlockNumber;
}

interface MigrateContractWrapperOptions {
    files: string[];
    inplace: boolean;
}

export abstract class StarknetWrapper {
    constructor(
        protected externalServer: ExternalServer,
        protected hre: HardhatRuntimeEnvironment
    ) {
        // this is dangerous since hre get set here, before being fully initialized (e.g. active network not yet set)
        // it's dangerous because in getters (e.g. get gatewayUrl) we rely on it being initialized
    }

    protected get gatewayUrl(): string {
        const url = this.hre.starknet.networkConfig.url;
        if (this.externalServer.isDockerDesktop) {
            for (const protocol of ["http://", "https://", ""]) {
                for (const host of ["localhost", "127.0.0.1"]) {
                    if (url === `${protocol}${host}`) {
                        return `${protocol}${DOCKER_HOST}`;
                    }

                    const prefix = `${protocol}${host}:`;
                    if (url.startsWith(prefix)) {
                        return url.replace(prefix, `${protocol}${DOCKER_HOST}:`);
                    }
                }
            }
        }
        return url;
    }

    private get chainID(): StarknetChainId {
        return this.hre.starknet.networkConfig.starknetChainId;
    }

    private get networkID(): string {
        return this.hre.starknet.network;
    }

    public async execute(
        command:
            | "starknet"
            | "starknet-compile-deprecated"
            | "get_class_hash"
            | "cairo-migrate"
            | "get_contract_class"
            | "get_contract_class_hash"
            | "get_compiled_class_hash",
        args: string[]
    ): Promise<ProcessResult> {
        return await this.externalServer.post<ProcessResult>({
            command,
            args
        });
    }

    protected prepareDeprecatedCompileOptions(options: CompileWrapperOptions): string[] {
        const ret = [
            options.file,
            "--abi",
            options.abi,
            "--output",
            options.output,
            "--cairo_path",
            options.cairoPath
        ];

        if (options.accountContract) {
            ret.push("--account_contract");
        }

        if (options.disableHintValidation) {
            ret.push("--disable_hint_validation");
        }

        return ret;
    }

    public async deprecatedCompile(options: CompileWrapperOptions): Promise<ProcessResult> {
        const preparedOptions = this.prepareDeprecatedCompileOptions(options);
        const executed = await this.execute("starknet-compile-deprecated", preparedOptions);
        return executed;
    }

    public abstract compileCairoToSierra(options: CairoToSierraOptions): Promise<ProcessResult>;

    public abstract compileSierraToCasm(options: SierraToCasmOptions): Promise<ProcessResult>;

    public prepareDeclareOptions(options: DeclareWrapperOptions): string[] {
        const prepared = [
            "declare",
            "--deprecated",
            "--contract",
            options.contract,
            "--gateway_url",
            this.gatewayUrl,
            "--feeder_gateway_url",
            this.gatewayUrl,
            "--no_wallet"
        ];

        if (options.signature && options.signature.length) {
            prepared.push("--signature", ...options.signature);
        }

        if (options.token) {
            prepared.push("--token", options.token);
        }

        if (options.sender) {
            prepared.push("--sender", options.sender);
        }

        if (options.maxFee == null) {
            throw new StarknetPluginError("No maxFee provided for declare tx");
        }

        prepared.push("--chain_id", this.chainID);
        prepared.push("--max_fee", options.maxFee);

        if (options.nonce) {
            prepared.push("--nonce", options.nonce);
        }

        return prepared;
    }

    public async declare(options: DeclareWrapperOptions): Promise<ProcessResult> {
        const preparedOptions = this.prepareDeclareOptions(options);
        const executed = await this.execute("starknet", preparedOptions);
        return executed;
    }

    protected prepareCairoToSierraOptions(options: CairoToSierraOptions): string[] {
        const args = [];

        if (options?.replaceIds === true) {
            args.push("-r");
        }

        if (options.allowedLibfuncsListName) {
            args.push("--allowed-libfuncs-list-name", options.allowedLibfuncsListName);
        }

        if (options.allowedLibfuncsListFile) {
            args.push("--allowed-libfuncs-list-file", options.allowedLibfuncsListFile);
        }

        args.push(options.path);

        if (options.output) {
            args.push(options.output);
        }

        return args;
    }

    protected prepareSierraToCasmOptions(options: SierraToCasmOptions): string[] {
        const args = [];
        if (options.allowedLibfuncsListName) {
            args.push("--allowed-libfuncs-list-name", options.allowedLibfuncsListName);
        }

        if (options.allowedLibfuncsListFile) {
            args.push("--allowed-libfuncs-list-file", options.allowedLibfuncsListFile);
        }

        if (options?.addPythonicHints === true) {
            args.push("--add-pythonic-hints");
        }

        args.push(options.file);

        if (options.output) {
            args.push(options.output);
        }

        return args;
    }

    protected getCairo1Command(binDirPath: string, binCommand: string, args: string[]): string[] {
        if (!binDirPath) {
            const msg =
                "No compiler bin directory specified\n" +
                "Specify one of {dockerizedVersion,cairo1BinDir} in the hardhat config file OR --cairo1-bin-dir in the CLI";
            throw new StarknetPluginError(msg);
        }

        const cairo1Bin = path.join(binDirPath, binCommand);
        return [cairo1Bin, ...args];
    }

    protected prepareInteractOptions(options: InteractWrapperOptions): string[] {
        const prepared = [
            ...options.choice.cliCommand,
            "--feeder_gateway_url",
            this.gatewayUrl,
            "--gateway_url",
            this.gatewayUrl,
            "--function",
            options.functionName,
            "--address",
            options.address,
            "--no_wallet"
        ];

        if (options.abi) {
            prepared.push("--abi", options.abi);
        }

        if (options.inputs && options.inputs.length) {
            prepared.push("--inputs", ...options.inputs);
        }

        if (options.signature && options.signature.length) {
            prepared.push("--signature", ...options.signature);
        }

        if (options.blockNumber != null) {
            prepared.push("--block_number", options.blockNumber.toString());
        }

        prepared.push("--chain_id", this.chainID);

        if (options.choice.allowsMaxFee && options.maxFee) {
            prepared.push("--max_fee", options.maxFee);
        }

        if (options.nonce) {
            prepared.push("--nonce", options.nonce);
        }

        return prepared;
    }

    public abstract interact(options: InteractWrapperOptions): Promise<ProcessResult>;

    protected prepareTxQueryOptions(command: string, options: TxHashQueryWrapperOptions): string[] {
        return [
            command,
            "--hash",
            options.hash,
            "--gateway_url",
            this.gatewayUrl,
            "--feeder_gateway_url",
            this.gatewayUrl
        ];
    }

    public async getTxStatus(options: TxHashQueryWrapperOptions): Promise<ProcessResult> {
        const preparedOptions = this.prepareTxQueryOptions("tx_status", options);
        const executed = await this.execute("starknet", preparedOptions);
        return executed;
    }

    public async getTransactionTrace(options: TxHashQueryWrapperOptions): Promise<ProcessResult> {
        const preparedOptions = this.prepareTxQueryOptions("get_transaction_trace", options);
        const executed = await this.execute("starknet", preparedOptions);
        return executed;
    }

    public async getTransactionReceipt(options: TxHashQueryWrapperOptions): Promise<ProcessResult> {
        const preparedOptions = this.prepareTxQueryOptions("get_transaction_receipt", options);
        const executed = await this.execute("starknet", preparedOptions);
        return executed;
    }

    public async getTransaction(options: TxHashQueryWrapperOptions): Promise<ProcessResult> {
        const preparedOptions = this.prepareTxQueryOptions("get_transaction", options);
        const executed = await this.execute("starknet", preparedOptions);
        return executed;
    }

    protected prepareBlockQueryOptions(options: BlockQueryWrapperOptions): string[] {
        const commandArr = [
            "get_block",
            "--gateway_url",
            this.gatewayUrl,
            "--feeder_gateway_url",
            this.gatewayUrl
        ];

        if (options?.hash) {
            commandArr.push("--hash");
            commandArr.push(options.hash);
        }

        if (options?.number) {
            commandArr.push("--number");
            commandArr.push(options.number.toString());
        }

        return commandArr;
    }

    public async getBlock(options: BlockQueryWrapperOptions): Promise<ProcessResult> {
        const preparedOptions = this.prepareBlockQueryOptions(options);
        const executed = await this.execute("starknet", preparedOptions);
        return executed;
    }

    protected prepareNonceQueryOptions(options: NonceQueryWrapperOptions): string[] {
        const commandArr = [
            "get_nonce",
            "--feeder_gateway_url",
            this.gatewayUrl,
            "--contract_address",
            options.address
        ];

        if (options.blockHash) {
            commandArr.push("--block_hash", options.blockHash);
        }

        if (options.blockNumber != null) {
            commandArr.push("--block_number", options.blockNumber.toString());
        }

        return commandArr;
    }

    public async getNonce(options: NonceQueryWrapperOptions): Promise<ProcessResult> {
        const preparedOptions = this.prepareNonceQueryOptions(options);
        const executed = await this.execute("starknet", preparedOptions);
        return executed;
    }

    public async getClassHash(artifactPath: string): Promise<string> {
        const executed = await this.execute("get_class_hash", [artifactPath]);
        if (executed.statusCode) {
            throw new StarknetPluginError(executed.stderr.toString());
        }
        return executed.stdout.toString().trim();
    }

    public async getCompiledClassHash(casmPath: string): Promise<string> {
        const executed = await this.execute("get_compiled_class_hash", [casmPath]);
        if (executed.statusCode) {
            throw new StarknetPluginError(executed.stderr.toString());
        }
        return executed.stdout.toString().trim();
    }

    public async getSierraContractClassHash(casmPath: string): Promise<string> {
        const executed = await this.execute("get_contract_class_hash", [casmPath]);
        if (executed.statusCode) {
            throw new StarknetPluginError(executed.stderr.toString());
        }
        return executed.stdout.toString().trim();
    }

    public async migrateContract(options: MigrateContractWrapperOptions): Promise<ProcessResult> {
        const commandArr = [...options.files];

        if (options.inplace) {
            commandArr.push("-i");
        }
        const executed = await this.execute("cairo-migrate", commandArr);
        if (executed.statusCode) {
            throw new StarknetPluginError(executed.stderr.toString());
        }
        return executed;
    }

    public async estimateMessageFee(
        functionName: string,
        fromAddress: string,
        toAddress: string,
        inputs: string[]
    ): Promise<FeeEstimation> {
        const body = {
            from_address: fromAddress,
            to_address: toAddress,
            entry_point_selector: hash.getSelectorFromName(functionName),
            payload: inputs.map((item) => number.toHex(number.toBN(item)))
        };

        const response = await axios.post(
            `${this.hre.starknet.networkConfig.url}/feeder_gateway/estimate_message_fee`,
            body
        );

        const { gas_price, gas_usage, overall_fee, unit } = response.data;
        return {
            amount: BigInt(overall_fee),
            unit,
            gas_price: BigInt(gas_price),
            gas_usage: BigInt(gas_usage)
        };
    }
}

function getFullImageName(image: Image): string {
    return `${image.repository}:${image.tag}`;
}

export class DockerWrapper extends StarknetWrapper {
    constructor(
        private image: Image,
        private rootPath: string,
        cairoPaths: string[],
        hre: HardhatRuntimeEnvironment
    ) {
        const externalServer = new StarknetDockerProxy(image, rootPath, cairoPaths);
        super(externalServer, hre);
        console.log(
            `${PLUGIN_NAME} plugin using dockerized environment (${getFullImageName(image)})`
        );
    }

    public async compileCairoToSierra(options: CairoToSierraOptions): Promise<ProcessResult> {
        const args = this.prepareCairoToSierraOptions(options);
        const command = this.getCairo1Command(DOCKER_HOST_BIN_PATH, CAIRO1_COMPILE_BIN, args);
        const externalServer = new DockerCairo1Compiler(this.image, [this.rootPath], command);

        return await externalServer.compileCairo1();
    }

    public async compileSierraToCasm(options: SierraToCasmOptions): Promise<ProcessResult> {
        const args = this.prepareSierraToCasmOptions(options);
        const command = this.getCairo1Command(
            DOCKER_HOST_BIN_PATH,
            CAIRO1_SIERRA_COMPILE_BIN,
            args
        );
        const externalServer = new DockerCairo1Compiler(this.image, [this.rootPath], command);

        return await externalServer.compileCairo1();
    }

    public async interact(options: InteractWrapperOptions): Promise<ProcessResult> {
        const preparedOptions = this.prepareInteractOptions(options);
        const executed = this.execute("starknet", preparedOptions);
        return executed;
    }
}

export class VenvWrapper extends StarknetWrapper {
    constructor(venvPath: string, hre: HardhatRuntimeEnvironment) {
        let pythonPath: string;
        if (venvPath === "active") {
            console.log(`${PLUGIN_NAME} plugin using the active environment.`);
            pythonPath = "python3";
        } else {
            venvPath = normalizeVenvPath(venvPath);
            console.log(`${PLUGIN_NAME} plugin using environment at ${venvPath}`);
            pythonPath = getPrefixedCommand(venvPath, "python3");
        }

        super(new StarknetVenvProxy(pythonPath), hre);
    }

    protected override get gatewayUrl(): string {
        return this.hre.starknet.networkConfig.url;
    }

    public async compileCairoToSierra(options: CairoToSierraOptions): Promise<ProcessResult> {
        const args = this.prepareCairoToSierraOptions(options);
        const command = this.getCairo1Command(options.binDirPath, CAIRO1_COMPILE_BIN, args);

        const executed = exec(command.join(" "));
        return executed;
    }

    public async compileSierraToCasm(options: SierraToCasmOptions): Promise<ProcessResult> {
        const args = this.prepareSierraToCasmOptions(options);
        const command = this.getCairo1Command(options.binDirPath, CAIRO1_SIERRA_COMPILE_BIN, args);

        const executed = exec(command.join(" "));
        return executed;
    }

    public async interact(options: InteractWrapperOptions): Promise<ProcessResult> {
        const preparedOptions = this.prepareInteractOptions(options);
        const executed = await this.execute("starknet", preparedOptions);
        return executed;
    }
}
