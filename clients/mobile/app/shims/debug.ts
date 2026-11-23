/** The TV client's request trace (../tv/devices/debug.ts): to the console in debug builds. */
export const trace = (message: string) => {
  if (__DEV__) console.log(message);
};
