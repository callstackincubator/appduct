import { isAppductLink } from "@appduct/react-native";

// Expo Router would navigate to `/` on the Appduct pairing link. An empty result makes it ignore
// the link; Appduct's own listener still receives it.
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  if (isAppductLink(path)) return "";
  return path;
}
