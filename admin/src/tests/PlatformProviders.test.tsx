import {beforeEach,expect,it,vi} from 'vitest';
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import PlatformProviders from '../components/PlatformProviders';
import {platformApi,type ProviderPolicyList} from '../api/platform';
import {authApi} from '../api/client';
vi.mock('../components/useConsolePreferences',()=>({useConsolePreferences:()=>({language:'en'})}));
vi.mock('../api/platform',()=>({platformApi:{providerPolicy:vi.fn(),proposeProviderPolicy:vi.fn(),reviewProviderPolicy:vi.fn()}}));
vi.mock('../api/client',()=>({authApi:{stepUp:vi.fn()}}));
const data:ProviderPolicyList={current:{version:0,provider:'none',mode:'off',blockSuspicious:false,hasCredential:false},items:[],nextBefore:null,runtimeReady:true};
beforeEach(()=>{
 vi.resetAllMocks();
 HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
 HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 vi.mocked(platformApi.providerPolicy).mockResolvedValue(structuredClone(data));
 vi.mocked(authApi.stepUp).mockResolvedValue({expiresAt:'2026-11-01T00:00:00Z'});
});
async function configure(){
 fireEvent.click(await screen.findByRole('button',{name:'Propose change'}));
 fireEvent.change(screen.getByLabelText('Provider'),{target:{value:'iphub'}});
 fireEvent.change(screen.getByLabelText('New API key (empty keeps current)'),{target:{value:'synthetic-provider-key'}});
 fireEvent.change(screen.getByLabelText('Mode'),{target:{value:'enforce'}});
 fireEvent.change(screen.getByLabelText('Your password'),{target:{value:'synthetic-password'}});
}
it('persists the explicitly chosen provider and credential only after password confirmation',async()=>{
 render(<PlatformProviders canPropose canApprove={false}/>);
 await configure();
 fireEvent.click(screen.getByRole('button',{name:'Submit for approval'}));
 await screen.findByText('Change saved. Status refreshed.');
 expect(authApi.stepUp).toHaveBeenCalledWith('synthetic-password');
 expect(platformApi.proposeProviderPolicy).toHaveBeenCalledWith(expect.objectContaining({provider:'iphub',mode:'enforce',apiKey:'synthetic-provider-key',expectedVersion:0}));
 expect(screen.queryByLabelText('New API key (empty keeps current)')).toBeNull();
});
it('read-only account cannot configure and enforcement needs an available runtime and credential',async()=>{
 const v=render(<PlatformProviders canPropose={false} canApprove={false}/>);
 await screen.findByText(/Credential: Not stored/);
 expect(screen.queryByRole('button',{name:'Propose change'})).toBeNull();
 v.rerender(<PlatformProviders canPropose canApprove={false}/>);
 fireEvent.click(screen.getByRole('button',{name:'Propose change'}));
 fireEvent.change(screen.getByLabelText('Provider'),{target:{value:'iphub'}});
 fireEvent.change(screen.getByLabelText('Mode'),{target:{value:'enforce'}});
 fireEvent.change(screen.getByLabelText('Your password'),{target:{value:'test'}});
 expect(screen.getByRole('button',{name:'Submit for approval'})).toBeDisabled();
 expect(platformApi.proposeProviderPolicy).not.toHaveBeenCalled();
});
it('uncertain saves lock fields, clear inputs and retry the exact immutable request',async()=>{
 vi.mocked(platformApi.proposeProviderPolicy).mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce({id:'saved'});
 render(<PlatformProviders canPropose canApprove={false}/>);
 await configure();
 fireEvent.click(screen.getByRole('button',{name:'Submit for approval'}));
 const retry=await screen.findByRole('button',{name:'Retry same request'});
 expect(screen.getByLabelText('Provider')).toBeDisabled();
 expect(screen.getByLabelText('New API key (empty keeps current)')).toHaveValue('');
 expect(screen.getByLabelText('Your password')).toHaveValue('');
 const input=vi.mocked(platformApi.proposeProviderPolicy).mock.calls[0][0];
 fireEvent.change(screen.getByLabelText('Your password'),{target:{value:'retry-password'}});
 fireEvent.click(retry);
 await screen.findByText('Change saved. Status refreshed.');
 expect(vi.mocked(platformApi.proposeProviderPolicy).mock.calls[1][0]).toEqual(input);
});
it('a denied refresh clears the current configuration and late previous responses cannot restore it',async()=>{
 const v=render(<PlatformProviders canPropose canApprove={false}/>);
 await screen.findByText(/Credential: Not stored/);
 let resolve!:(v:ProviderPolicyList)=>void;
 vi.mocked(platformApi.providerPolicy).mockImplementationOnce(()=>new Promise(r=>{resolve=r;})).mockRejectedValueOnce({response:{status:403}});
 v.rerender(<PlatformProviders canPropose canApprove={false} refreshRevision={1}/>);
 await waitFor(()=>expect(platformApi.providerPolicy).toHaveBeenCalledTimes(2));
 v.rerender(<PlatformProviders canPropose canApprove={false} refreshRevision={2}/>);
 await screen.findByRole('alert');
 await act(async()=>resolve({...data,current:{...data.current,version:9}}));
 expect(screen.queryByRole('button',{name:'Propose change'})).toBeNull();
 expect(screen.queryByText(/Credential: Not stored/)).toBeNull();
});
