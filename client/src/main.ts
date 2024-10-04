import { APP_BASE_HREF, registerLocaleData } from '@angular/common'
import { provideHttpClient } from '@angular/common/http'
import { APP_INITIALIZER, ApplicationRef, enableProdMode, importProvidersFrom, LOCALE_ID, provideZoneChangeDetection } from '@angular/core'
import { BrowserModule, bootstrapApplication, enableDebugTools, provideClientHydration } from '@angular/platform-browser'
import { BrowserAnimationsModule } from '@angular/platform-browser/animations'
import { RouteReuseStrategy, provideRouter, withInMemoryScrolling, withPreloading } from '@angular/router'
import { ServiceWorkerModule } from '@angular/service-worker'
import localeOc from '@app/helpers/locales/oc'
import { getFormProviders } from '@app/shared/shared-forms/shared-form-providers'
import { NgbModalModule } from '@ng-bootstrap/ng-bootstrap'
import { LoadingBarModule } from '@ngx-loading-bar/core'
import { LoadingBarHttpClientModule } from '@ngx-loading-bar/http-client'
import { ToastModule } from 'primeng/toast'
import { AppComponent } from './app/app.component'
import routes from './app/app.routes'
import {
  CustomReuseStrategy,
  MenuGuards,
  PluginService,
  PreloadSelectedModulesList,
  RedirectService,
  ServerService,
  getCoreProviders
} from './app/core'
import { polyfillICU } from './app/helpers'
import { getMainProviders } from './app/shared/shared-main/main-providers'
import { environment } from './environments/environment'
import { logger } from './root-helpers'

registerLocaleData(localeOc, 'oc')

export function loadConfigFactory (server: ServerService) {

  return () => {
    console.log('getConfig')
    return server.getConfig()
  }
}

if (environment.production) {
  enableProdMode()
}

logger.registerServerSending(environment.apiUrl)

export const bootstrap = () => bootstrapApplication(AppComponent, {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),

    importProvidersFrom(
      BrowserModule,
      BrowserAnimationsModule,
      ServiceWorkerModule.register('ngsw-worker.js', { enabled: environment.production })
    ),

    provideHttpClient(),

    importProvidersFrom(
      LoadingBarHttpClientModule,
      LoadingBarModule,
      ToastModule,
      NgbModalModule
    ),

    getCoreProviders(),
    getMainProviders(),
    getFormProviders(),
    {
      provide: LOCALE_ID, useValue: 'en-US'
    },

    PreloadSelectedModulesList,
    ...MenuGuards.guards,
    { provide: RouteReuseStrategy, useClass: CustomReuseStrategy },

    provideRouter(routes,
      withPreloading(PreloadSelectedModulesList),
      withInMemoryScrolling({
        anchorScrolling: 'disabled',
        // Redefined in app component
        scrollPositionRestoration: 'disabled'
      })
    ),

    {
      provide: APP_BASE_HREF,
      useValue: '/'
    },
    {
      provide: APP_INITIALIZER,
      useFactory: loadConfigFactory,
      deps: [ ServerService, PluginService, RedirectService ],
      multi: true
    },
    {
      provide: APP_INITIALIZER,
      useFactory: () => polyfillICU,
      multi: true
    },
    provideClientHydration()
  ]
})
  .then(bootstrapModule => {
    if (!environment.production) {
      const applicationRef = bootstrapModule.injector.get(ApplicationRef)
      const componentRef = applicationRef.components[0]

      // allows to run `ng.profiler.timeChangeDetection();`
      enableDebugTools(componentRef)
    }

    return bootstrapModule
  })
  .catch(err => {
    try {
      logger.error(err)
    } catch (err2) {
      console.error('Cannot log error', { err, err2 })
    }

    // Ensure we display an "incompatible message" on Angular bootstrap error
    setTimeout(() => {
      if (document.querySelector('my-app').innerHTML === '') {
        throw err
      }
    }, 1000)

    return null
  })

bootstrap()
