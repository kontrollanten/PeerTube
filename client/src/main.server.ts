import { bootstrapApplication, provideClientHydration } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { provideServerRendering } from '@angular/platform-server';
import { getCoreProviders, ServerService } from '@app/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import routes from '@app/app.routes';
import { getMainProviders } from '@app/shared/shared-main/main-providers';
import { getFormProviders } from '@app/shared/shared-forms/shared-form-providers';
import { APP_INITIALIZER } from '@angular/core';

function loadConfigFactory (server: ServerService) {
	return () => {
	  console.log('getConfig')
	  return server.getConfig()
	}
  }

const bootstrap = () =>
	bootstrapApplication(AppComponent, {
		providers: [
			provideHttpClient(),
			getCoreProviders(),
			getMainProviders(),
			getFormProviders(),

			provideRouter(routes),
			provideServerRendering(),
			provideClientHydration(),
			{
			  provide: APP_INITIALIZER,
			  useFactory: loadConfigFactory,
			  deps: [ ServerService ],
			  multi: true
			},
		],
	});

export default bootstrap;