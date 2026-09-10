import { AmazonSpApiSendAdapter } from "../services/amazonSpApiSendAdapter";
import { createProviderWorker } from "./providerWorker";

export default createProviderWorker("amazon", () => new AmazonSpApiSendAdapter());
