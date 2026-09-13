export const resolvePort = (value = process.env.PORT): number => {
  if (value === undefined) return 8080;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }

  return port;
};
