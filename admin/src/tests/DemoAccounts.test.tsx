import {beforeEach,describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import DemoAccounts from '../components/DemoAccounts';
import {demoApi} from '../api/demo';
vi.mock('../components/useConsolePreferences',()=>({useConsolePreferences:()=>({language:'en'})}));
vi.mock('../api/demo',()=>({demoApi:{accounts:vi.fn(),login:vi.fn()}}));
const accounts=[{id:'synthetic-a',email:'council.1@demo.ertad.local',label:'Council one',region:'Both regions'}];
beforeEach(()=>{vi.resetAllMocks();vi.mocked(demoApi.accounts).mockResolvedValue({enabled:true,accounts});});
describe('Local demo account selector',()=>{
  it('does not display accounts when the server disables the feature',async()=>{
    vi.mocked(demoApi.accounts).mockResolvedValue({enabled:false,accounts});render(<DemoAccounts onLogin={vi.fn()} disabled={false}/>);
    await waitFor(()=>expect(demoApi.accounts).toHaveBeenCalled());expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('only completes login after the server returns a session',async()=>{
    const complete=vi.fn(),response={csrfToken:'synthetic',user:{id:'synthetic-a',email:accounts[0].email,role:'superadmin' as const}};
    vi.mocked(demoApi.login).mockResolvedValue(response);render(<DemoAccounts onLogin={complete} disabled={false}/>);
    fireEvent.click(await screen.findByRole('button',{name:/Council one/}));
    await waitFor(()=>expect(complete).toHaveBeenCalledWith(response));expect(demoApi.login).toHaveBeenCalledWith('synthetic-a');
  });
  it('keeps failed sign-in on the selector and allows an explicit retry',async()=>{
    const complete=vi.fn();vi.mocked(demoApi.login).mockRejectedValue(new Error('Synthetic denied'));
    render(<DemoAccounts onLogin={complete} disabled={false}/>);fireEvent.click(await screen.findByRole('button',{name:/Council one/}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in failed');expect(complete).not.toHaveBeenCalled();
    expect(screen.getByRole('button',{name:/Council one/})).toBeEnabled();
  });
});
