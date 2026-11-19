import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Collective from '../pages/Collective';
import { collectiveApi, type Proposal } from '../api/collective';
vi.mock('../components/useConsolePreferences',()=>({useConsolePreferences:()=>({language:'en'})}));
vi.mock('../api/demo',()=>({demoApi:{scenario:vi.fn().mockRejectedValue(new Error('Not demo'))}}));
vi.mock('../api/collective',async importOriginal=>({...await importOriginal<typeof import('../api/collective')>(),collectiveApi:{contexts:vi.fn(),units:vi.fn(),list:vi.fn(),detail:vi.fn(),funding:vi.fn()}}));
const proposal={id:'p',kind:'funding_receipt',unitId:'u',workId:'w',parameters:{amount:'12345'},proposerId:'author',reason:'Checked external receipt',status:'pending',canVote:true,votes:[],threshold:1,approvedCount:0,eligibleCount:1,deadline:'2099-01-01T00:00:00Z',version:1,canWithdraw:false} as Proposal;
beforeEach(()=>{
 vi.clearAllMocks();vi.mocked(collectiveApi.contexts).mockResolvedValue([{id:'org',name:'ERTAD'}]);
 vi.mocked(collectiveApi.units).mockResolvedValue([{id:'u',name:'Region A',canPropose:false,canManage:false,policy:{version:0,method:'fixed',minimum:1}}]);
 vi.mocked(collectiveApi.list).mockResolvedValue({items:[proposal],total:1,page:1});vi.mocked(collectiveApi.detail).mockResolvedValue(proposal);
});
it('shows the exact scoped currency before allowing a funding review',async()=>{
 vi.mocked(collectiveApi.funding).mockResolvedValue({actorId:'reviewer',canRecord:true,canParticipate:true,canReadRecords:true,target:{currency:'USD',goal:'50000',purpose:'Task',version:1,isEnvelope:false,suppressed:false,totals:null}});
 render(<MemoryRouter><Collective/></MemoryRouter>);fireEvent.click(await screen.findByRole('button',{name:'Funding receipt · Region A'}));
 await screen.findByText('123.45 USD');expect(screen.getByRole('button',{name:'Record decision'})).toBeVisible();expect(collectiveApi.funding).toHaveBeenCalledWith('org','w');
});
it('does not show an actionable review when the scoped currency lookup fails',async()=>{
 vi.mocked(collectiveApi.funding).mockRejectedValue(new Error('Access revoked'));
 render(<MemoryRouter><Collective/></MemoryRouter>);fireEvent.click(await screen.findByRole('button',{name:'Funding receipt · Region A'}));
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Could not load records'));
 expect(screen.queryByRole('button',{name:'Record decision'})).not.toBeInTheDocument();
});
