import { registerRootComponent } from 'expo';
import App from '@unomed/react-native-matrix-sdk-example/src/App';

// The app itself lives in the bare example and is imported across the workspace
// rather than copied. The two examples exist to compare *native contracts* - bare
// React Native against Expo's Continuous Native Generation - so the JavaScript
// they run has to be identical, or a difference in behaviour proves nothing about
// the thing being tested.

// registerRootComponent registers the component as "main", which is the module
// name `expo prebuild` writes into MainActivity.kt and the iOS AppDelegate.
registerRootComponent(App);
