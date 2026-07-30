interface Opts {
  verbose: boolean;
}

export function parseOpts(o: Opts) {
  return o.verbose;
}
