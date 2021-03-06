import {
    ParticleSystemSet, Observer, ParticleSystem, Tools as BabylonTools,
    FilesInputStore, Vector3, ParticleHelper, FactorGradient
} from 'babylonjs';
import Editor, {
    EditorPlugin, Tools,
    Layout, Toolbar, Tree, Window,
    Dialog, UndoRedo, GraphicsTools,
    Storage, ParticlesCreatorMetadata, INumberDictionary
} from 'babylonjs-editor';

import Helpers, { Preview } from '../helpers';

import Timeline from './timeline';

export default class ParticlesCreator extends EditorPlugin {
    // Public members
    public layout: Layout = null;
    public toolbar: Toolbar = null;
    public tree: Tree = null;
    public tabs: W2UI.W2Tabs = null;

    public undoRedoId: string = 'particles-creator';

    // Protected members
    protected data: ParticlesCreatorMetadata = null;

    protected preview: Preview = null;
    protected set: ParticleSystemSet = null;

    protected timeline: Timeline = null;
    protected currentParticleSystem: ParticleSystem = null;
    protected onSelectAssetObserver: Observer<any> = null;

    // Private members
    private _modifyingObjectObserver: Observer<any>;
    private _modifiedObjectObserver: Observer<any>;

    // Static members
    public static DefaultSet: any = null;

    /**
     * Constructor
     * @param name: the name of the plugin 
     */
    constructor(public editor: Editor, asset: ParticlesCreatorMetadata = null) {
        super('Particle Systems Creator');
        this.data = asset;
    }

    /**
     * Closes the plugin
     */
    public async close (): Promise<void> {
        this.layout.element.destroy();
        this.toolbar.element.destroy();

        this.preview.scene.dispose();
        this.preview.engine.dispose();

        this.timeline.dispose();

        this.editor.core.onSelectAsset.remove(this.onSelectAssetObserver);
        this.editor.core.onModifyingObject.remove(this._modifyingObjectObserver);
        this.editor.core.onModifiedObject.remove(this._modifiedObjectObserver);

        await super.close();
    }

    /**
     * Creates the plugin
     */
    public async create(): Promise<void> {
        // Default
        if (!ParticlesCreator.DefaultSet) {
            const set = await Tools.LoadFile<string>('./assets/templates/particles-creator/default-set.json', false);
            ParticlesCreator.DefaultSet = JSON.parse(set);
        }

        // Layout
        this.layout = new Layout(this.divElement.id);
        this.layout.panels = [
            { type: 'top', size: 30, resizable: false, content: `<div id="PARTICLES-CREATOR-TOOLBAR" style="width: 100%; height: 100%"></div>` },
            {
                type: 'left',
                size: '50%',
                resizable: false, 
                content: `
                    <div id="PARTICLES-CREATOR-TREE" style="width: 100%; height: 100%;"></div>
                    <div id="PARTICLES-CREATOR-TIMELINE" style="width: 100%; height: 100%; overflow: hidden;"></div>`,
                tabs: <any> [
                    { id: 'tree', caption: 'List' },
                    { id: 'timeline', caption: 'Timeline' }
                ]
            },
            { type: 'main', size: '50%', resizable: false,  content: `<canvas id="PARTICLES-CREATOR-CANVAS" style="width: 100%; height: 100%; position: absolute; top: 0;"></canvas>` },
        ];
        this.layout.build(this.divElement.id);

        // Tabs
        this.tabs = this.layout.getPanelFromType('left').tabs;
        this.tabs.on('click', (ev) => this.tabChanged(ev.target));
        this.tabs.select('timeline');
        this.tabChanged('timeline');

        // Toolbar
        this.toolbar = new Toolbar('PARTICLES-CREATOR-TOOLBAR');
        this.toolbar.helpUrl = 'https://doc.babylonjs.com/resources/using_particlesystemeditor';
        this.toolbar.items = [
            { id: 'add', text: 'Add System...', caption: 'Add System...', img: 'icon-add' },
            { id: 'reset', text: 'Reset', caption: 'Reset', img: 'icon-play-game' },
            { type: 'break' },
            { id: 'export', text: 'Export As...', caption: 'Export As...', img: 'icon-export' },
            { id: 'import', text: 'Import From...', caption: 'Import From...', img: 'icon-add' },
            { type: 'break' },
            { id: 'preset', type: 'menu', text: 'Presets', caption: 'Presets', img: 'icon-particles', items: [
                { id: 'smoke', text: 'Smoke', caption: 'Smoke' },
                { id: 'sun', text: 'Sun', caption: 'Sun' },
                // { id: 'rain', text: 'Rain', caption: 'Rain' },
                { id: 'fire', text: 'Fire', caption: 'Fire' },
                { id: 'explosion', text: 'Explosion', caption: 'Explosion' }
            ] }
        ];
        this.toolbar.onClick = id => this.toolbarClicked(id);
        this.toolbar.build('PARTICLES-CREATOR-TOOLBAR');
        this.toolbar.items.forEach(i => this.toolbar.enable(i.id, false));

        // Create tree
        this.tree = new Tree('PARTICLES-CREATOR-TREE');
        this.tree.wholerow = true;
        this.tree.onClick = (<ParticleSystem> (id, data) => {
            this.currentParticleSystem = data;
            this.editor.core.onSelectObject.notifyObservers(data);
        });
        this.tree.onCanDrag = () => false;
        this.tree.onRename = (<ParticleSystem> (id, name, data) => {
            this.currentParticleSystem.name = name;
            this.resetSet(true);
            return true;
        });
        this.tree.onContextMenu = (<ParticleSystem> (id, data) => {
            return [
                { id: 'remove', text: 'Remove', callback: () => this.removeSystemFromSet(data) }
            ];
        });
        this.tree.build('PARTICLES-CREATOR-TREE');

        // Create timeline
        this.timeline = new Timeline(this, <HTMLDivElement> $('#PARTICLES-CREATOR-TIMELINE')[0]);

        // Create preview
        this.preview = Helpers.CreatePreview(<HTMLCanvasElement> $('#PARTICLES-CREATOR-CANVAS')[0]);
        this.preview.camera.wheelPrecision = 100;
        this.preview.engine.runRenderLoop(() => this.preview.scene.render());

        // Events
        this.onSelectAssetObserver = this.editor.core.onSelectAsset.add((a) => this.selectAsset(a));
        this._modifyingObjectObserver = this.editor.core.onModifyingObject.add((o: ParticleSystem) => {
            if (!this.data)
                return;
            
            this.timeline.onModifyingSystem(o);
            this.saveSet();
        });
        this._modifiedObjectObserver = this.editor.core.onModifiedObject.add((o: ParticleSystem) => {
            if (!this.data)
                return;

            this.timeline.onModifiedSystem(o);
            this.saveSet();
        });

        // Select asset
        if (this.data)
            this.selectAsset(this.data);
    }

    /**
     * On hide the plugin (do not render scene)
     */
    public onHide (): void {

    }

    /**
     * On show the plugin (render scene)
     */
    public onShow (asset?: ParticlesCreatorMetadata): void {
        
    }

    /**
     * Called on the window, layout etc. is resized.
     */
    public onResize (): void {
        this.layout.element.resize();
        this.preview.engine.resize();

        const size = this.layout.getPanelSize('left');
        this.timeline.resize(size.width, size.height);
    }

    /**
     * Called on the user clicks on an item of the toolbar
     * @param id the id of the clicked item
     */
    protected async toolbarClicked (id: string): Promise<void> {
        switch (id) {
            // Add a new particle systems set
            case 'add':
                const name = await Dialog.CreateWithTextInput('Particle System name?');
                await this.addSystemToSet(ParticlesCreator.DefaultSet.systems[0], name);
                this.saveSet();
                this.resetSet(true);
                break;
            // Reset particle systems set
            case 'reset':
                this.resetSet(true);
                break;

            // Export / Import
            case 'export':
                this.exportSet();
                break;
            case 'import':
                this.importSet();
                break;

            // Presets
            case 'preset:smoke': this.createFromPreset('smoke'); break;
            case 'preset:sun': this.createFromPreset('sun'); break;
            case 'preset:rain': this.createFromPreset('rain'); break;
            case 'preset:fire': this.createFromPreset('fire'); break;
            case 'preset:explosion': this.createFromPreset('explosion'); break;
        }
    }

    /**
     * Called on the user changes tab
     * @param id the id of the new tab
     */
    protected tabChanged (id: string): void {
        // Hide all
        $('#PARTICLES-CREATOR-TREE').hide();
        $('#PARTICLES-CREATOR-TIMELINE').hide();

        // Select which to show
        switch (id) {
            case 'tree': $('#PARTICLES-CREATOR-TREE').show(); break;
            case 'timeline': $('#PARTICLES-CREATOR-TIMELINE').show(); break;
            default: break;
        }
    }

    /**
     * Called on the user selects an asset in the assets panel
     * @param asset the asset being selected
     */
    protected selectAsset (asset: ParticlesCreatorMetadata): void {
        if (!asset || !asset.psData) {
            // Lock toolbar
            this.toolbar.items.forEach(i => this.toolbar.enable(i.id, false));
            return;
        }

        // Unlock toolbar
        this.toolbar.items.forEach(i => this.toolbar.enable(i.id, true));

        // Misc.
        this.data = asset;

        // Set
        if (this.set) {
            this.set.dispose();
            this.set = null;
        }

        this.resetSet(true);

        // Timeline
        this.timeline.setSet(this.set);

        // Undo/Redo
        UndoRedo.ClearScope(this.undoRedoId);
    }

    /**
     * Adds a new particle system to the current set according to the given data.
     * @param particleSystemData the particle system data to parse.
     * @param name the name to force to the system to add.
     */
    protected addSystemToSet (particleSystemData: any, name?: string): Promise<ParticleSystem> {
        if (!this.set)
            return;

        // Replace id
        particleSystemData.id = BabylonTools.RandomId();

        return new Promise<ParticleSystem>((resolve) => {
            // Create system
            const rootUrl = particleSystemData.textureName ? (particleSystemData.textureName.indexOf('data:') === 0 ? '' : 'file:') : '';

            const ps = ParticleSystem.Parse(particleSystemData, this.preview.scene, rootUrl, true);
            ps.emitter = ps.emitter || Vector3.Zero();
            ps.name = name || ps.name;

            this._cleanGradients(ps);

            // Add to set
            this.set.systems.push(ps);

            // Resolve
            if (ps.particleTexture && rootUrl === 'file:')
                ps.particleTexture.onLoadObservable.add(tex => resolve(ps));
            else
                resolve(ps);
        });
    }

    /**
     * Removes the given particle system from the current set
     * @param ps the particle system to remove
     */
    public removeSystemFromSet (ps: ParticleSystem): void {
        // Remove from set
        const index = this.set.systems.indexOf(ps);
        if (index === -1)
            return;

        this.set.systems.splice(index, 1);

        // Finally dispose
        ps.dispose();

        // Remove from tree
        this.tree.remove(ps.id);

        // Save & reset
        this.saveSet();
        this.resetSet(true);
    }

    /**
     * Clones the given particle system
     * @param ps the particle system to clone
     */
    public async cloneSystem (ps: ParticleSystem): Promise<void> {
        try {
            const clone = ps.serialize();
            await this.addSystemToSet(clone, ps.name + ' Clone');

            this.saveSet();
            this.resetSet(true);
        } catch (e) {
            Window.CreateAlert(`<h2>${e.message}</h2><br/>${e.stack}`, `Can't clone the system`)
        }
    }

    /**
     * Resets the particle systems set
     * @param fillTree wehter or not the list tree should be filled.
     */
    public async resetSet (fillTree: boolean = false): Promise<void> {
        if (!this.data)
            return;

        // Const data
        const data = this.set ? this.set.serialize() : this.data.psData;

        // Dispose previous set
        if (this.set) {
            this.set.dispose();
            this.preview.scene.particleSystems = [];
        }

        // Clear tree?
        if (fillTree)
            this.tree.clear();

        // Parse set
        this.set = new ParticleSystemSet();
        for (const s of data.systems) {
            const ps = await this.addSystemToSet(s);
            if (fillTree)
                this.tree.add({ id: ps.id, text: ps.name, data: ps, img: 'icon-particles' });
        }

        this.set.start();

        if (this.currentParticleSystem) {
            const ps = this.set.systems.find(ps => ps.name === this.currentParticleSystem.name);
            if (ps) {
                this.tree.select(ps.id);
                this.editor.core.onSelectObject.notifyObservers(ps);
            }
        }

        // Refresh timeline
        this.timeline.setSet(this.set);
    }

    /**
     * Saves the current particle systems set
     */
    public saveSet (): void {
        if (!this.data)
            return;

        // Save!
        this.data.psData = this.set.serialize();
    }

    /**
     * Exports the current set
     */
    protected async exportSet (): Promise<void> {
        if (!this.data)
            return;
        
        // Save
        this.saveSet();

        // Export
        const serializationObject = this.set.serialize();

        // Embed?
        const embed = await Dialog.Create('Embed textures?', 'Do you want to embed textures in the set?');
        if (embed === 'Yes') {
            for (const s of serializationObject.systems) {
                const file = FilesInputStore.FilesToLoad[s.textureName.toLowerCase()];
                if (!file)
                    continue;
                
                s.textureName = await Tools.ReadFileAsBase64(file);
            }
        }
        else {
            for (const s of serializationObject.systems) {
                s.textureName = 'textures/' + s.textureName;
            }
        }

        // Save data
        const json = JSON.stringify(serializationObject, null, '\t');
        const file = Tools.CreateFile(Tools.ConvertStringToUInt8Array(json), this.data.name + '.json');

        // Embeded
        if (embed === 'Yes')
            return BabylonTools.Download(file, file.name);

        // Not embeded
        const textureFiles: File[] = [];
        for (const s of serializationObject.systems) {
            const file = FilesInputStore.FilesToLoad[s.textureName.replace('textures/', '').toLowerCase()];
            if (!file || textureFiles.indexOf(file) !== -1)
                continue;
            
            textureFiles.push(file);
        }

        const storage = await Storage.GetStorage(this.editor);
        await storage.openPicker('Choose destination folder...', [
            { name: file.name, file: file },
            { name: 'textures', folder: textureFiles.map(tf => ({
                name: tf.name,
                file: tf
            })) }
        ]);
    }

    /**
     * Imports a set
     */
    protected async importSet (): Promise<void> {
        // Lock
        this.layout.lockPanel('top', 'Importing...');

        // Get files
        const files = await Tools.OpenFileDialog();
        for (const f of files) {
            const ext = Tools.GetFileExtension(f.name);
            if (ext !== 'json')
                continue;

            const content = JSON.parse(await Tools.ReadFileAsText(f));
            if (!content.systems)
                continue;
            
            for (const s of content.systems) {
                if (s.textureName && s.textureName.indexOf('data:') === -1) {
                    // Create texture
                    const path = Tools.GetFilePath(f).replace(f.name, '');
                    const filename = Tools.GetFilename(s.textureName);
                    
                    try {
                        FilesInputStore.FilesToLoad[filename.toLowerCase()] = await Tools.GetFile(path + s.textureName);
                        s.textureName = filename;
                    } catch (e) {
                        continue;
                    }
                }
                
                this.addSystemToSet(s);
            };
        }

        // Unlock
        this.layout.unlockPanel('top');

        // Save and reset
        this.saveSet();
        this.resetSet(true);
    }

    /**
     * Creates a new system set from the already know presets form babylonjs.com
     * @param preset the preset id to create from the babylon.js presets
     */
    protected async createFromPreset (preset: string): Promise<void> {
        // Ask override
        const override = await Dialog.Create('Override current set?', 'Setting from a preset will override your current set configuration. Are you sure?');
        if (override === 'No')
            return;

        // Lock panel
        this.layout.lockPanel('top', 'Loading...', true);

        // Dispose existing set
        if (this.set)
            this.set.dispose();
        
        // Create set!
        this.set = await ParticleHelper.CreateAsync(preset, this.preview.scene);
        this.set.systems.forEach(s => this._cleanGradients(<ParticleSystem> s));

        // Save textures
        const promises: Promise<void>[] = [];
        for (const s of this.set.systems) {
            promises.push(new Promise<void>((resolve) => {
                s.particleTexture.onLoadObservable.addOnce(async tex => {
                    const blob = await GraphicsTools.TextureToFile(tex);
                    const split = tex.name.split('/');
                    const name = split[split.length - 1];

                    blob['name'] = tex.name = tex.url = name.toLowerCase();
                    FilesInputStore.FilesToLoad[name.toLowerCase()] = <File> blob;

                    resolve();
                });
            }));
        }

        await Promise.all(promises);

        // Save and reset
        this.saveSet();
        this.resetSet(true);

        // Unlock
        this.layout.unlockPanel('top');
    }

    /**
     * Cleans the size gradients
     * @param system the system to clean
     * @todo remove this fix in future
     */
    private _cleanGradients (system: ParticleSystem): void {
        const sizeGradients = system['_sizeGradients'];
        if (!sizeGradients)
            return;
        
        const gradientsDict: INumberDictionary<FactorGradient[]> = { };
        sizeGradients.forEach(sg => {
            gradientsDict[sg.gradient] = gradientsDict[sg.gradient] || [];
            gradientsDict[sg.gradient].push(sg);
        });

        sizeGradients.splice(0, sizeGradients.length);
        for (const k in gradientsDict) {
            const g = gradientsDict[k];
            while (g.length > 1)
                g.pop();

            sizeGradients.push(g[0])
        }

        system['_sizeGradients'] = sizeGradients;
    }
}
