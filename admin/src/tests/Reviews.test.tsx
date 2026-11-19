import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Reviews from '../pages/Reviews';
import { reviewApi } from '../api/reviews';
import { authApi } from '../api/client';
vi.mock('../components/useConsolePreferences',()=>({useConsolePreferences:()=>({language:'en'})}));
vi.mock('../api/client',()=>({authApi:{stepUp:vi.fn()}}));
vi.mock('../api/reviews',()=>({reviewApi:{contexts:vi.fn(),list:vi.fn(),detail:vi.fn(),propose:vi.fn(),decide:vi.fn(),notifications:vi.fn(),read:vi.fn()}}));
const row={id:'review',requester_id:'opaque-requester',unit_id:'unit',position_id:'position',unit_name:'Local unit',position_name:'Coordinator',created_at:'2026-10-04T12:00:00Z',expires_at:'2030-10-04T12:00:00Z',status:'pending' as const};
const detail={...row,target_id:'opaque-target',reason:'Synthetic proposal reason',valid_until:'2030-11-04T12:00:00Z',bundle_version:1,decision_by:null,decision_reason:null,decision_at:null,canDecide:true};
const mount=(path='/reviews')=>render(<MemoryRouter initialEntries={[path]}><Reviews/></MemoryRouter>);
beforeEach(()=>{
  vi.resetAllMocks();
  vi.mocked(reviewApi.contexts).mockResolvedValue([{id:'org',name:'Organization',positions:[{id:'position',name:'Coordinator',unitId:'unit',unitName:'Local unit',canPropose:true}]}]);
  vi.mocked(reviewApi.list).mockResolvedValue({items:[row],total:1,page:1,pageSize:25});
  vi.mocked(reviewApi.detail).mockResolvedValue(detail);
  vi.mocked(reviewApi.notifications).mockResolvedValue({items:[]});
  vi.mocked(authApi.stepUp).mockResolvedValue({} as never);
});
describe('Membership reviews',()=>{
  it('prefills the existing proposal form from scoped member navigation',async()=>{
    const memberId='33333333-1234-4321-8123-012345678901';
    render(<MemoryRouter initialEntries={[{pathname:'/reviews',state:{memberDirectory:{organizationId:'org',memberId}}}]}><Reviews/></MemoryRouter>);
    expect(await screen.findByLabelText('Existing member reference')).toHaveValue(memberId);
    expect(reviewApi.propose).not.toHaveBeenCalled();
  });
  it('shows an access explanation without a fabricated empty queue',async()=>{
    vi.mocked(reviewApi.contexts).mockResolvedValue([]);mount();
    expect(await screen.findByText(/No review access/)).toBeInTheDocument();
    expect(reviewApi.list).not.toHaveBeenCalled();expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
  it('distinguishes a failed request from an empty successful inbox and retries',async()=>{
    vi.mocked(reviewApi.list).mockRejectedValueOnce(new Error('offline'));mount();
    expect(await screen.findByRole('alert')).toBeInTheDocument();expect(screen.queryByText('No requests in this view.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Retry'}));expect(await screen.findByRole('table')).toBeInTheDocument();
  });
  it('renders permitted table data, localized deadlines and bounded pagination',async()=>{
    mount();expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader',{name:'Requester reference'})).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Next',exact:true})).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Search unit or position'),{target:{value:'Local'}});
    await waitFor(()=>expect(reviewApi.list).toHaveBeenLastCalledWith(expect.objectContaining({search:'Local',page:1})));
  });
  it('does not render action controls for a non-independent reviewer',async()=>{
    vi.mocked(reviewApi.detail).mockResolvedValue({...detail,canDecide:false});mount();
    fireEvent.click(await screen.findByRole('button',{name:'Details: Coordinator'}));
    expect(await screen.findByText(/cannot be decided/)).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Approve',exact:true})).not.toBeInTheDocument();
    await waitFor(()=>expect(screen.getByRole('heading',{name:'Details'})).toHaveFocus());
  });
  async function fillDecision(){
    fireEvent.click(await screen.findByRole('button',{name:'Details: Coordinator'}));
    fireEvent.change(await screen.findByLabelText('Decision reason (10–1000 characters)'),{target:{value:'Independent synthetic approval'}});
    fireEvent.click(screen.getByLabelText('I have reviewed the proposed change and its duration.'));
    fireEvent.change(screen.getByLabelText('Confirm with your password'),{target:{value:'synthetic-password'}});
    fireEvent.click(screen.getByRole('button',{name:'Approve',exact:true}));
  }
  it('never reports success on conflict and retains the request for review',async()=>{
    vi.mocked(reviewApi.decide).mockRejectedValue({response:{status:409}});mount();await fillDecision();
    expect(await screen.findByText(/This request changed/)).toBeInTheDocument();expect(screen.queryByText('Decision saved.')).not.toBeInTheDocument();
  });
  it('retries a lost decision response with the identical key and immutable payload',async()=>{
    vi.mocked(reviewApi.decide).mockRejectedValueOnce(new Error('lost response')).mockResolvedValue({id:'review',status:'approved'});
    mount();await fillDecision();
    const retry=await screen.findByRole('button',{name:'Retry unchanged submission'});
    const original=vi.mocked(reviewApi.decide).mock.calls[0][0];
    expect(screen.getByLabelText('Decision reason (10–1000 characters)')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Confirm with your password'),{target:{value:'synthetic-password'}});fireEvent.click(retry);
    expect(await screen.findByText('Decision saved.')).toBeInTheDocument();
    expect(vi.mocked(reviewApi.decide).mock.calls[1][0]).toEqual(original);
    expect(original.key).toMatch(/^[\da-f-]{36}$/);
  });
  it('marking a notification read never executes a decision',async()=>{
    vi.mocked(reviewApi.notifications).mockResolvedValue({items:[{id:'review',status:'approved',created_at:row.created_at,read_at:null}]});
    vi.mocked(reviewApi.read).mockResolvedValue();mount('/reviews?view=notifications');
    fireEvent.click(await screen.findByRole('button',{name:'Mark as read'}));
    await waitFor(()=>expect(reviewApi.read).toHaveBeenCalledWith('org','review'));
    expect(reviewApi.decide).not.toHaveBeenCalled();
  });
});
