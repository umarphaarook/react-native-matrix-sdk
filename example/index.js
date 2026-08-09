import { registerRootComponent } from 'expo';
import App from './src/App';

// registerRootComponent registers the component as "main", which is the module
// name `expo prebuild` writes into MainActivity.kt and the iOS AppDelegate.
registerRootComponent(App);
