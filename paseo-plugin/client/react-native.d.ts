/**
 * Minimal local declarations for the React Native primitives this plugin's
 * client entry uses. Paseo supplies the real runtime modules; installing
 * react-native here would only bloat the typecheck.
 */
declare module "react-native" {
  export const View: any;
  export const Text: any;
  export const Pressable: any;
  export const TextInput: any;
  export const Switch: any;
  export const ScrollView: any;
  export const ActivityIndicator: any;
  export const Platform: { OS: "ios" | "android" | "web" | "windows" | "macos" };
}
