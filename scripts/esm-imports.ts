import { Bundler } from "../local/bundler";

const bundler = new Bundler();

bundler.bundle({ ext: ".js", outDir: "./dist" });
