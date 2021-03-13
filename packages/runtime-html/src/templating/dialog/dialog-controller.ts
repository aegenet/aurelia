import { IContainer, newInstanceForScope, newInstanceOf, onResolve, Registration } from '@aurelia/kernel';
import { LifecycleFlags } from '@aurelia/runtime';
import { ISyntheticView } from '../controller.js';
import {
  IDialogComponent,
  IDialogController,
  IDialogRenderer,
  LoadedDialogSettings,
} from './dialog-interfaces.js';
import {
  createDialogCancelError,
  createDialogCloseError,
} from './dialog-utilities.js';

import type {
  IDialogCancelableOperationResult,
  IDialogCloseResult,
} from './dialog-interfaces.js';
import { IComposer, ICompositionContext } from '../composer.js';

export const enum ActivationResult {
  none = 0,
  error = 1,
  cancelled = 2,
}

/**
 * A controller object for a Dialog instance.
 */
export class DialogController implements IDialogController {
  private readonly container: IContainer;
  private readonly viewModel: IDialogComponent<object>;
  private readonly composer: IComposer;
  private readonly resolve: (data?: any) => void;
  private readonly reject: (reason: any) => void;

  /**
   * @internal
   */
  public closePromise: Promise<any> | undefined;

  /**
   * The settings used by this controller.
   */
  public readonly settings: LoadedDialogSettings;

  /**
   * @internal
   */
  public renderer: IDialogRenderer;

  /**
   * The component controller associated with this dialog controller
   */
  public controller!: ISyntheticView;

  protected static inject = [IContainer, IComposer];

  public constructor(
    container: IContainer,
    composer: IComposer,
    settings: LoadedDialogSettings,
    resolve: (data?: any) => void,
    reject: (reason: any) => void
  ) {
    Registration.instance(IDialogController, this).register(container);
    this.container = container;
    this.composer = composer;
    this.settings = settings;
    this.viewModel = DialogController.getOrCreateVm(container, settings);
    this.renderer = container.get(newInstanceOf(IDialogRenderer));
    this.resolve = resolve;
    this.reject = reject;
  }

  private static getOrCreateVm(container: IContainer, settings: LoadedDialogSettings): IDialogComponent<object> {
    const ViewModel = settings.viewModel;
    return typeof ViewModel === 'object'
      ? ViewModel
      : ViewModel == null
        ? new EmptyViewModel()
        : container.invoke(ViewModel);
  }

  /**
   * @internal
   */
  public activate(): ActivationResult | Promise<ActivationResult> {
    const { container, viewModel, settings, renderer, settings: { model, rejectOnCancel } } = this;

    return onResolve(
      viewModel.canActivate?.(model),
      (canActivate) => {
        if (!canActivate) {
          if (!rejectOnCancel) {
            return ActivationResult.cancelled;
          }
          return ActivationResult.error;
        }

        const compositionContext: ICompositionContext<object> = {
          viewModel: viewModel,
          host: renderer.host,
          template: settings.template,
          container: container,
        };
        const controller = this.controller = this.composer.compose(compositionContext);

        return onResolve(
          onResolve(
            renderer.attaching(),
            () => controller.activate(controller, null!, LifecycleFlags.fromBind, null!),
          ),
          () => onResolve(
            onResolve(
              // TODO: which comes first: activate for loading data or attached for ... maybe animation?
              viewModel.activate?.(model),
              () => renderer.attached(),
            ),
            () => ActivationResult.none,
          ),
        );
      },
    );
  }

  /**
   * @internal
   */
  public deactivate(ok: boolean, output?: any): Promise<IDialogCancelableOperationResult> {
    if (this.closePromise) {
      return this.closePromise;
    }

    const { viewModel, settings: { rejectOnCancel }} = this;
    const dialogResult: IDialogCloseResult = { wasCancelled: !ok, output };

    return this.closePromise = new Promise(r => r(viewModel.canDeactivate?.(dialogResult)))
      .catch(reason => {
        this.closePromise = undefined;
        return Promise.reject(reason);
      })
      .then(canDeactivate => {
        if (!canDeactivate) {
          // we are done, do not block consecutive calls
          this.closePromise = undefined;
          if (!rejectOnCancel) {
            return { wasCancelled: true };
          }
          throw createDialogCancelError();
        }
        return new Promise(r => r(viewModel.deactivate?.(dialogResult)))
          .then(() => this.controller.deactivate(this.controller, null!, LifecycleFlags.fromUnbind))
          .then(() => {
            if (!rejectOnCancel || ok) {
              this.resolve(dialogResult);
            } else {
              this.reject(createDialogCancelError(output));
            }
            return { wasCancelled: false };
          })
          .catch(reason => {
            this.closePromise = undefined;
            return Promise.reject(reason);
          });
      });
  }

  /**
   * Closes the dialog with a successful output.
   * @param output The returned success output.
   */
  public ok(output?: any): Promise<IDialogCancelableOperationResult> {
    return this.close(true, output);
  }

  /**
   * Closes the dialog with a cancel output.
   * @param output The returned cancel output.
   */
  public cancel(output?: any): Promise<IDialogCancelableOperationResult> {
    return this.close(false, output);
  }

  /**
   * Closes the dialog with an error output.
   * @param output A reason for closing with an error.
   * @returns Promise An empty promise object.
   */
  public error(output: any): Promise<void> {
    const closeError = createDialogCloseError(output);
    return new Promise(r => r(this.viewModel.deactivate?.(closeError)))
      .then(() => this.controller.deactivate(this.controller, null!, LifecycleFlags.fromUnbind))
      .then(() => { this.reject(closeError); });
  }

  /**
   * Closes the dialog.
   * @param ok Whether or not the user input signified success.
   * @param output The specified output.
   * @returns Promise An empty promise object.
   */
  public close(ok: boolean, output?: any): Promise<IDialogCancelableOperationResult> {
    return this.deactivate(ok, output);
  }
}

class EmptyViewModel {}
