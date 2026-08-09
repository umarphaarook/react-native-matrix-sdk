import * as React from 'react';

import { StyleSheet, View, Text, TextInput, Button } from 'react-native';
import { ClientBuilder, initPlatform, LogLevel } from '@unomed/react-native-matrix-sdk';

// `initPlatform` sets up logging and the tokio runtime, and on Android it also
// initializes `rustls-platform-verifier` with the application context. Without
// it, the first TLS request panics inside Rust.
//
// It must only run once per process; a Fast Refresh re-evaluating this module
// would otherwise trip the SDK's "logger already initialized" error.
let platformInitialized = false;

function initPlatformOnce() {
  if (platformInitialized) {
    return;
  }
  platformInitialized = true;

  initPlatform({
    logLevel: LogLevel.Debug,
    traceLogPacks: [],
    extraTargets: [],
    // Logs go to logcat on Android, stdout elsewhere.
    writeToStdoutOrSystem: true,
    writeToFiles: undefined,
  }, false);
}

export default function App() {
  const [homeserver, setHomeserver] = React.useState("https://matrix.org");
  const [status, setStatus] = React.useState("");

  React.useEffect(() => {
    initPlatformOnce();
  }, []);

  const updateHomeserverLoginDetails = React.useCallback(async () => {
    if (!homeserver.length) {
      setStatus("");
      return;
    }

    try {
      const client = await (new ClientBuilder()).homeserverUrl(homeserver).build();
      const loginDetails = await client.homeserverLoginDetails();

      setStatus(`url: ${loginDetails.url()}\n`
        + `supportsOidcLogin: ${loginDetails.supportsOauthLogin()}\n`
        + `supportsPasswordLogin: ${loginDetails.supportsPasswordLogin()}`);
    } catch (error) {
      setStatus(`${error}`);
    }
  }, [homeserver]);

  return (
    <View style={styles.container}>
      <TextInput value={homeserver} onChangeText={setHomeserver}></TextInput>
      <Button title='Go' onPress={updateHomeserverLoginDetails}></Button>
      <Text>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  }
});
